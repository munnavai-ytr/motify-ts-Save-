import {
  buildThinkingConfig,
  callGeminiGenerateContent,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_TRANSIENT_ATTEMPTS,
  DEFAULT_TOTAL_BUDGET_MS,
  formatShortModelName,
  isAbortError,
  normalizeBareModelKey,
  type GeminiContent,
  type GeminiGenerateResult,
  type GeminiRetryInfo,
  type GeminiStatusEvent,
  type GeminiTransport,
} from '@/lib/ai/gemini-client';
import { GeminiRequestError, type GeminiErrorKind } from '@/lib/ai/gemini-errors';
import type { GeminiModel } from '@/lib/gemini';
import {
  getStoredAutoBackupModels,
  getStoredCachedModels,
} from '@/lib/storage';
import type { GeminiUsageMetadata } from '@/lib/types';

export const MODEL_COOLDOWN_MS = 120_000;
export const MAX_AUTO_BACKUP_MODELS = 2;

const EXCLUDED_AUTO_MODEL_TOKENS = [
  'tts',
  'image',
  'embedding',
  'live',
  'audio',
  'aqa',
  'robotics',
  'computer',
  'veo',
  'imagen',
] as const;

const FALLBACK_ELIGIBLE_KINDS = new Set<GeminiErrorKind>([
  'overloaded',
  'timeout',
  'quota_minute',
  'quota_day',
  'model_not_found',
]);

const COOLDOWN_KINDS = new Set<GeminiErrorKind>([
  'overloaded',
  'timeout',
  'timeout_budget',
  'quota_minute',
  'quota_day',
  'model_not_found',
]);

// Process-wide map tracking bare model keys -> epoch ms until cooldown ends.
const modelCooldownUntil = new Map<string, number>();

export function clearAllModelCooldowns(): void {
  modelCooldownUntil.clear();
}

export function getModelCooldownUntil(modelName: string): number | undefined {
  const key = normalizeBareModelKey(modelName);
  if (!key) return undefined;
  const until = modelCooldownUntil.get(key);
  if (until === undefined) return undefined;
  if (until <= Date.now()) {
    modelCooldownUntil.delete(key);
    return undefined;
  }
  return until;
}

function markModelCooldown(modelName: string, nowMs = Date.now()): void {
  const key = normalizeBareModelKey(modelName);
  if (!key) return;
  modelCooldownUntil.set(key, nowMs + MODEL_COOLDOWN_MS);
}

function clearModelCooldown(modelName: string): void {
  const key = normalizeBareModelKey(modelName);
  if (!key) return;
  modelCooldownUntil.delete(key);
}

export interface GeminiPolicyParams {
  apiKey: string;
  modelName: string;
  backupModelName?: string;
  availableModels?: readonly GeminiModel[];
  autoPickBackups?: boolean;
  systemInstruction?: string;
  contents: GeminiContent[];
  temperature?: number;
  maxOutputTokens?: number;
  thinkingConfigMode?: 'none' | 'auto_low';
  thinkingConfig?: Record<string, unknown>;
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: Record<string, unknown>;
  maxTransientAttemptsPerModel?: number;
  retryDelaysMs?: number[];
  retryAfterCapMs?: number;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  timeScale?: number;
  transport?: GeminiTransport;
  signal?: AbortSignal;
  onStatus?: (event: GeminiStatusEvent) => void;
  onRetry?: (info: GeminiRetryInfo) => void;
  onAttempt?: (info: {
    modelName: string;
    usage?: GeminiUsageMetadata;
    ok?: boolean;
  }) => void;
}

export interface GeminiPolicyResult extends GeminiGenerateResult {
  answeringModel: string;
  requestedModel: string;
  usedBackup: boolean;
  attemptedModels: string[];
}

function isEligibleAutoBackupModel(model: GeminiModel): boolean {
  if (!model.supportedGenerationMethods.includes('generateContent')) {
    return false;
  }
  const bare = normalizeBareModelKey(model.name);
  if (!bare) return false;
  for (const token of EXCLUDED_AUTO_MODEL_TOKENS) {
    if (bare.includes(token)) {
      return false;
    }
  }
  return true;
}

function getAutoModelPriorityTier(modelName: string): number {
  const bare = normalizeBareModelKey(modelName);
  if (bare.includes('flash-lite')) return 0;
  if (bare.includes('flash')) return 1;
  return 2;
}

export function buildModelCandidateChain(params: {
  primaryModel: string;
  backupModel?: string;
  availableModels?: readonly GeminiModel[];
  autoPickBackups?: boolean;
}): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];

  const pushUnique = (raw: string | undefined) => {
    const trimmed = raw?.trim() ?? '';
    if (!trimmed) return;
    const key = normalizeBareModelKey(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    chain.push(trimmed);
  };

  pushUnique(params.primaryModel);
  pushUnique(params.backupModel);

  const shouldAutoPick =
    params.autoPickBackups !== undefined
      ? params.autoPickBackups
      : getStoredAutoBackupModels();

  if (shouldAutoPick) {
    const pool = params.availableModels ?? getStoredCachedModels();
    const candidates = pool
      .filter((m) => isEligibleAutoBackupModel(m))
      .filter((m) => !seen.has(normalizeBareModelKey(m.name)))
      .map((m, index) => ({
        name: m.name,
        tier: getAutoModelPriorityTier(m.name),
        index,
      }))
      .sort((a, b) => a.tier - b.tier || a.index - b.index);

    let added = 0;
    for (const candidate of candidates) {
      if (added >= MAX_AUTO_BACKUP_MODELS) break;
      const before = chain.length;
      pushUnique(candidate.name);
      if (chain.length > before) {
        added += 1;
      }
    }
  }

  return chain;
}

function sortChainByHealth(
  candidates: readonly string[],
  nowMs = Date.now()
): string[] {
  const healthy: string[] = [];
  const cooling: Array<{ model: string; until: number; index: number }> = [];

  candidates.forEach((model, index) => {
    const key = normalizeBareModelKey(model);
    const until = modelCooldownUntil.get(key);
    if (until !== undefined && until > nowMs) {
      cooling.push({ model, until, index });
    } else {
      if (until !== undefined && until <= nowMs) {
        modelCooldownUntil.delete(key);
      }
      healthy.push(model);
    }
  });

  cooling.sort((a, b) => a.until - b.until || a.index - b.index);
  return [...healthy, ...cooling.map((c) => c.model)];
}

function describeFallbackReason(kind: GeminiErrorKind): string {
  switch (kind) {
    case 'overloaded':
      return 'overloaded';
    case 'timeout':
      return 'timed out';
    case 'timeout_budget':
      return 'time budget reached';
    case 'quota_minute':
      return 'rate limited';
    case 'quota_day':
      return 'daily quota reached';
    case 'model_not_found':
      return 'model not found';
    default:
      return kind;
  }
}

export async function callGeminiWithPolicy(
  params: GeminiPolicyParams
): Promise<GeminiPolicyResult> {
  if (params.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const primaryModel = params.modelName.trim();
  const backupModel = params.backupModelName?.trim() ?? '';

  const timeScale =
    typeof params.timeScale === 'number' &&
    Number.isFinite(params.timeScale) &&
    params.timeScale > 0
      ? params.timeScale
      : 1;

  const totalBudgetMs = params.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const scaledTotalBudgetMs = Math.max(20, Math.round(totalBudgetMs * timeScale));
  const deadlineMs = Date.now() + scaledTotalBudgetMs;

  const maxAttemptsPerModel = Math.max(
    1,
    params.maxTransientAttemptsPerModel ?? DEFAULT_MAX_TRANSIENT_ATTEMPTS
  );

  const attemptTimeoutMs = params.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const attemptedModels: string[] = [];

  const resolveThinkingConfig = (
    model: string
  ): Record<string, unknown> | undefined => {
    if (params.thinkingConfig) {
      return params.thinkingConfig;
    }
    if (params.thinkingConfigMode === 'auto_low') {
      return buildThinkingConfig(model);
    }
    return undefined;
  };

  const baseChain = buildModelCandidateChain({
    primaryModel,
    backupModel,
    availableModels: params.availableModels,
    autoPickBackups: params.autoPickBackups,
  });
  const orderedChain = sortChainByHealth(baseChain);
  const primaryBareKey = normalizeBareModelKey(primaryModel);

  let lastError: GeminiRequestError | null = null;
  let lastModel = primaryModel;

  for (let idx = 0; idx < orderedChain.length; idx += 1) {
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const currentModel = orderedChain[idx];
    const hasMoreModels = idx < orderedChain.length - 1;

    if (idx > 0 && lastError) {
      const shortPrev = formatShortModelName(lastModel);
      const shortCurrent = formatShortModelName(currentModel);
      params.onStatus?.({
        type: 'fallback',
        fromModel: shortPrev,
        toModel: shortCurrent,
        reasonKind: lastError.kind,
        message: `Switched to backup model ${shortCurrent} (${describeFallbackReason(lastError.kind)} on ${shortPrev})`,
      });
    }

    attemptedModels.push(currentModel);

    try {
      const res = await callGeminiGenerateContent({
        apiKey: params.apiKey,
        modelName: currentModel,
        systemInstruction: params.systemInstruction,
        contents: params.contents,
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens,
        thinkingConfig: resolveThinkingConfig(currentModel),
        responseMimeType: params.responseMimeType,
        responseSchema: params.responseSchema,
        maxTransientAttempts: maxAttemptsPerModel,
        maxConsecutiveFastFailAttempts: hasMoreModels ? 2 : undefined,
        retryDelaysMs: params.retryDelaysMs,
        retryAfterCapMs: params.retryAfterCapMs,
        attemptTimeoutMs,
        totalBudgetMs,
        deadlineMs,
        timeScale,
        isBackupAttempt: normalizeBareModelKey(currentModel) !== primaryBareKey,
        transport: params.transport,
        signal: params.signal,
        onStatus: params.onStatus,
        onRetry: params.onRetry,
        onAttempt: (usage, ok) =>
          params.onAttempt?.({
            modelName: currentModel,
            usage,
            ok,
          }),
      });

      clearModelCooldown(currentModel);

      return {
        ...res,
        answeringModel: res.modelName,
        requestedModel: primaryModel,
        usedBackup: normalizeBareModelKey(res.modelName) !== primaryBareKey,
        attemptedModels,
      };
    } catch (err: unknown) {
      if (isAbortError(err) || params.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (err instanceof GeminiRequestError) {
        if (COOLDOWN_KINDS.has(err.kind)) {
          markModelCooldown(currentModel);
        }

        const canContinue =
          hasMoreModels &&
          FALLBACK_ELIGIBLE_KINDS.has(err.kind) &&
          Date.now() < deadlineMs;

        if (canContinue) {
          lastError = err;
          lastModel = currentModel;
          continue;
        }
      }

      throw err;
    }
  }

  throw lastError ??
    new GeminiRequestError({
      kind: 'model_not_found',
      retryable: false,
      message: 'No Gemini model is available.',
      userAction: 'Open Settings, refresh models, and select a model.',
      explanation: 'Candidate model chain was empty.',
      rawDetails: 'Empty candidate model chain',
    });
}
