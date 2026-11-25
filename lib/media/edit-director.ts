import {
  buildThinkingConfig,
  type GeminiContent,
  type GeminiStatusEvent,
} from '@/lib/ai/gemini-client';
import { callGeminiWithPolicy } from '@/lib/ai/gemini-policy';
import { extractJsonFromText } from '@/lib/ai/plan-schema';
import { formatBytes } from '@/lib/media/process';
import type { GeminiUsageMetadata, MediaKind } from '@/lib/types';
import type { MediaAnalysis } from './analyzer';
import { EDIT_DIRECTOR_PROMPT } from './edit-director-prompt';
import {
  COLOR_GRADES,
  EDIT_SPEC_JSON_SCHEMA,
  MAX_TIMELINE_SECONDS,
  normalizeEditSpec,
  type ColorGradePreset,
  type EditFormat,
  type EditSpec,
} from './edit-types';

export interface MediaItem {
  id?: string;
  mediaId?: string;
  kind: MediaKind | 'file';
  name: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
}

export type EditDirectorStatus =
  | 'Analyzing your media'
  | 'Planning the edit'
  | 'Repairing the spec';

export interface GenerateEditSpecInput {
  userRequest: string;
  mediaItems: MediaItem[];
  analysis: MediaAnalysis | null;
  format: EditFormat;
  targetSeconds: number;
  language: 'en' | 'bn' | 'auto';
  referenceOnly?: boolean;
  referenceMediaIds?: string[];
  existingEditSpec?: EditSpec;
  allowHybridMG?: boolean;
  backupModelName?: string;
  onGeminiStatus?: (event: GeminiStatusEvent) => void;
}

export interface EditDirectorTokens {
  prompt: number;
  output: number;
  thinking: number;
}

export interface EditDirectorResult {
  spec: EditSpec;
  brief: string;
  warnings: string[];
  calls: number;
  tokens: EditDirectorTokens;
  ms: number;
  modelName?: string;
  usedBackupModel?: boolean;
}

export interface EnrichRequestOptions {
  targetSeconds?: number;
  format?: EditFormat;
  language?: 'en' | 'bn' | 'auto';
}

const BENGALI_CHAR_REGEX = /[\u0980-\u09FF]/;

const STYLE_KEYWORDS = [
  'warm',
  'cool',
  'vintage',
  'noir',
  'vibrant',
  'cinematic',
  'energetic',
  'upbeat',
  'calm',
  'minimal',
  'bold',
  'fast',
  'slow',
  'lofi',
  'corporate',
  'playful',
  'ambient',
  'retro',
  'dramatic',
  'moody',
  'neon',
  'pastel',
  'dark',
  'bright',
  'smooth',
  'snappy',
  'documentary',
  'vlog',
  'reel',
  'tiktok',
  'shorts',
  'promo',
  'explainer',
  'highlight',
  'montage',
  'style',
  'aesthetic',
  'grade',
  'pacing',
  'beat',
  'উষ্ণ',
  'সিনেমাটিক',
  'দ্রুত',
  'ধীর',
  'মিনিমাল',
  'রঙিন',
];

function resolveMediaId(item: MediaItem, index: number): string {
  const id = item.mediaId ?? item.id;
  if (id && id.trim().length > 0) return id.trim();
  return `media-${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStyleKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return STYLE_KEYWORDS.some((kw) => {
    if (/[\u0980-\u09FF]/.test(kw)) {
      return lower.includes(kw);
    }
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
}

export function shouldEnrichRequest(request: string): boolean {
  const words = request.trim().split(/\s+/).filter(Boolean);
  return words.length < 8 && !hasStyleKeyword(request);
}

function pickAnalysisColorGrade(
  analysis: MediaAnalysis | null
): ColorGradePreset | null {
  if (!analysis) return null;
  for (const item of analysis.items) {
    if (!item.colorGrade) continue;
    const normalized = item.colorGrade.trim().toLowerCase();
    if (normalized === 'neutral' || normalized === 'none') continue;
    if ((COLOR_GRADES as readonly string[]).includes(normalized)) {
      return normalized as ColorGradePreset;
    }
  }
  return null;
}

export function enrichRequest(
  shortRequest: string,
  analysis: MediaAnalysis | null,
  options?: EnrichRequestOptions
): string {
  const base = shortRequest.trim().replace(/[.!?।]+$/, '');
  const detectedBn = BENGALI_CHAR_REGEX.test(shortRequest);
  const useBengali =
    options?.language === 'bn' || (options?.language !== 'en' && detectedBn);

  const clauses: string[] = [];

  if (analysis?.overallMood && analysis.overallMood.trim().length > 0) {
    const mood = analysis.overallMood.trim();
    clauses.push(useBengali ? `মুড: ${mood}।` : `Mood: ${mood}.`);
  }

  if (
    analysis?.suggestedMusicStyle &&
    analysis.suggestedMusicStyle.trim().length > 0
  ) {
    const style = analysis.suggestedMusicStyle.trim();
    clauses.push(useBengali ? `মিউজিক: ${style}।` : `Music: ${style}.`);
  }

  const hasFastPacing =
    analysis?.items.some(
      (item) => typeof item.pacing === 'number' && item.pacing > 1.5
    ) ?? false;
  if (hasFastPacing) {
    clauses.push(
      useBengali ? 'গতি প্রাণবন্ত ও দ্রুত রাখুন।' : 'Keep the energy high.'
    );
  }

  const grade = pickAnalysisColorGrade(analysis);
  if (grade && grade !== 'none') {
    clauses.push(
      useBengali
        ? `${grade} কালার গ্রেড প্রয়োগ করুন।`
        : `Apply ${grade} color grade.`
    );
  }

  if (
    options?.targetSeconds !== undefined &&
    Number.isFinite(options.targetSeconds)
  ) {
    const secs = Math.round(options.targetSeconds);
    clauses.push(
      useBengali
        ? `মোট দৈর্ঘ্য: ${secs} সেকেন্ড।`
        : `Total duration: ${secs} seconds.`
    );
  }

  if (options?.format) {
    clauses.push(
      useBengali
        ? `ফরম্যাট: ${options.format}।`
        : `Format: ${options.format}.`
    );
  }

  if (clauses.length === 0) {
    return shortRequest.trim();
  }

  const prefix = base.length > 0 ? (useBengali ? `${base}।` : `${base}.`) : '';
  return [prefix, ...clauses].filter(Boolean).join(' ');
}

function getEditDirectorResponseSchema(): Record<string, unknown> {
  const baseProps = (EDIT_SPEC_JSON_SCHEMA.properties ?? {}) as Record<
    string,
    unknown
  >;
  const baseRequired = Array.isArray(EDIT_SPEC_JSON_SCHEMA.required)
    ? (EDIT_SPEC_JSON_SCHEMA.required as string[])
    : ['v', 'format', 'fps', 'totalSeconds', 'tracks'];

  return {
    ...EDIT_SPEC_JSON_SCHEMA,
    required: Array.from(new Set(['brief', ...baseRequired])),
    properties: {
      brief: { type: 'STRING', nullable: false },
      ...baseProps,
    },
  };
}

function buildMediaSummaryTable(
  mediaItems: MediaItem[],
  analysis: MediaAnalysis | null,
  referenceSet: Set<string>
): string {
  if (mediaItems.length === 0) {
    return 'No media items uploaded.';
  }
  const analysisById = new Map(
    (analysis?.items ?? []).map((item) => [item.mediaId, item])
  );
  const header = 'mediaId | kind | role | name | dimensions | duration | size';
  const divider = '--- | --- | --- | --- | --- | --- | ---';
  const rows = mediaItems.map((item, idx) => {
    const id = resolveMediaId(item, idx);
    const analyzed = analysisById.get(id);
    const role = referenceSet.has(id)
      ? 'REFERENCE ONLY (style inspiration - DO NOT place on timeline)'
      : item.kind === 'audio'
        ? analyzed?.audioRole ?? 'audio'
        : 'timeline';
    const dims =
      typeof item.width === 'number' &&
      typeof item.height === 'number' &&
      item.width > 0 &&
      item.height > 0
        ? `${item.width}x${item.height}`
        : 'unknown';
    const dur =
      typeof item.duration === 'number' &&
      Number.isFinite(item.duration) &&
      item.duration > 0
        ? `${item.duration.toFixed(2)}s`
        : item.kind === 'image'
          ? 'still'
          : 'unknown';
    return `${id} | ${item.kind} | ${role} | ${item.name} | ${dims} | ${dur} | ${formatBytes(item.size)}`;
  });
  return [header, divider, ...rows].join('\n');
}

function buildSystemPrompt(analysis: MediaAnalysis | null): string {
  const sections: string[] = [
    EDIT_DIRECTOR_PROMPT,
    `EDIT_SPEC_JSON_SCHEMA:\n${JSON.stringify(EDIT_SPEC_JSON_SCHEMA, null, 2)}`,
  ];

  if (analysis) {
    const compactAnalysis = {
      items: analysis.items,
      overallMood: analysis.overallMood,
      suggestedPalette: analysis.suggestedPalette,
      suggestedMusicStyle: analysis.suggestedMusicStyle,
    };
    sections.push(
      `MEDIA_ANALYSIS_JSON:\n${JSON.stringify(compactAnalysis, null, 2)}`
    );
  }

  return sections.join('\n\n');
}

function buildUserPrompt(
  effectiveRequest: string,
  input: GenerateEditSpecInput
): string {
  const referenceSet = new Set(input.referenceMediaIds ?? []);
  const mediaTable = buildMediaSummaryTable(
    input.mediaItems,
    input.analysis,
    referenceSet
  );
  const sections: string[] = [
    `USER REQUEST:\n${effectiveRequest}`,
    `TARGET SETTINGS:\n- format: ${input.format}\n- targetSeconds: ${input.targetSeconds}\n- language: ${input.language}\n- allowHybridMG: ${input.allowHybridMG !== false ? 'yes (use MGTrack only if branding/intro/outro/CTA helps)' : 'no (omit MGTracks)'}`,
    `UPLOADED MEDIA SUMMARY:\n${mediaTable}`,
  ];

  if (referenceSet.size > 0) {
    sections.push(
      `REFERENCE ONLY IDS (extract style/grade/pacing, NEVER place on any track): ${Array.from(referenceSet).join(', ')}`
    );
  }

  if (input.existingEditSpec) {
    sections.push(
      `PREVIOUS EDIT SPEC (revise this timeline according to USER REQUEST):\n${JSON.stringify(input.existingEditSpec)}`
    );
  }

  sections.push('Return valid JSON matching EditSpec + brief.');
  return sections.join('\n\n');
}

function addUsageTokens(
  totals: EditDirectorTokens,
  usage?: GeminiUsageMetadata
): void {
  if (!usage) return;
  totals.prompt += usage.promptTokenCount ?? 0;
  totals.output += usage.candidatesTokenCount ?? 0;
  totals.thinking += usage.thoughtsTokenCount ?? 0;
}

function clampBriefWords(rawBrief: unknown, fallback: string): string {
  const cleaned =
    typeof rawBrief === 'string' && rawBrief.trim().length > 0
      ? rawBrief.trim().replace(/\s+/g, ' ')
      : fallback;
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length <= 30) return words.join(' ');
  return `${words.slice(0, 30).join(' ')}…`;
}

function validateAgainstMediaItems(
  spec: EditSpec,
  mediaItems: MediaItem[],
  referenceIds: ReadonlyArray<string> = []
): string[] {
  const errors: string[] = [];
  const itemById = new Map<string, MediaItem>();
  const referenceSet = new Set(referenceIds);

  mediaItems.forEach((item, idx) => {
    itemById.set(resolveMediaId(item, idx), item);
  });

  if (spec.totalSeconds > MAX_TIMELINE_SECONDS) {
    errors.push(
      `totalSeconds (${spec.totalSeconds}s) exceeds maximum allowed ${MAX_TIMELINE_SECONDS}s.`
    );
  }

  spec.tracks.forEach((track, idx) => {
    if (track.kind === 'mg') {
      if (track.duration > 5) {
        errors.push(
          `tracks[${idx}].duration (${track.duration}s) for MGTrack must be <= 5s.`
        );
      }
      return;
    }

    if (referenceSet.has(track.mediaId)) {
      errors.push(
        `tracks[${idx}].mediaId "${track.mediaId}" is a REFERENCE ONLY item and must NOT be placed on the timeline.`
      );
      return;
    }

    const media = itemById.get(track.mediaId);
    if (!media) {
      errors.push(
        `tracks[${idx}].mediaId "${track.mediaId}" does not exist in uploaded mediaItems.`
      );
      return;
    }

    if (
      track.kind === 'video' &&
      media.kind === 'video' &&
      typeof media.duration === 'number' &&
      Number.isFinite(media.duration) &&
      media.duration > 0 &&
      track.outPoint > media.duration + 0.25
    ) {
      errors.push(
        `tracks[${idx}].outPoint (${track.outPoint}s) exceeds source "${track.mediaId}" duration (${media.duration.toFixed(2)}s).`
      );
    }
  });

  return errors;
}

function extractBriefAndSpecInput(parsed: unknown): {
  brief: string;
  specCandidate: unknown;
} {
  if (!isRecord(parsed)) {
    return { brief: '', specCandidate: parsed };
  }
  const rawBrief = parsed.brief;
  const rest: Record<string, unknown> = { ...parsed };
  delete rest.brief;
  return {
    brief: clampBriefWords(
      rawBrief,
      'Assembled timeline edit tailored to your media and request.'
    ),
    specCandidate: rest,
  };
}

export async function generateEditSpec(
  input: GenerateEditSpecInput,
  apiKey: string,
  modelName: string,
  signal?: AbortSignal,
  onStatus?: (status: EditDirectorStatus) => void
): Promise<EditDirectorResult> {
  const startedAt = performance.now();
  const tokens: EditDirectorTokens = { prompt: 0, output: 0, thinking: 0 };
  let calls = 0;

  let effectiveRequest = input.userRequest.trim();
  if (shouldEnrichRequest(effectiveRequest)) {
    const enriched = enrichRequest(effectiveRequest, input.analysis, {
      targetSeconds: input.targetSeconds,
      format: input.format,
      language: input.language,
    });
    console.info('[edit-director] Low-input enrichment applied:', {
      original: input.userRequest,
      enriched,
    });
    effectiveRequest = enriched;
  }

  const systemInstruction = buildSystemPrompt(input.analysis);
  const userMessage = buildUserPrompt(effectiveRequest, input);
  const responseSchema = getEditDirectorResponseSchema();
  const thinkingConfig = buildThinkingConfig(modelName);

  const contents: GeminiContent[] = [
    {
      role: 'user',
      parts: [{ text: userMessage }],
    },
  ];

  onStatus?.('Planning the edit');
  calls += 1;

  const firstRes = await callGeminiWithPolicy({
    apiKey,
    modelName,
    backupModelName: input.backupModelName,
    systemInstruction,
    contents,
    responseMimeType: 'application/json',
    responseSchema,
    temperature: 0.7,
    maxOutputTokens: 3000,
    thinkingConfig,
    onStatus: input.onGeminiStatus,
    signal,
  });
  addUsageTokens(tokens, firstRes.usageMetadata);

  const evaluateOutput = (rawText: string): {
    ok: boolean;
    spec?: EditSpec;
    brief?: string;
    warnings?: string[];
    errors: string[];
  } => {
    let parsed: unknown;
    try {
      parsed = extractJsonFromText(rawText);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }

    const { brief, specCandidate } = extractBriefAndSpecInput(parsed);
    const normalized = normalizeEditSpec(specCandidate);
    if (!normalized.ok) {
      return { ok: false, errors: normalized.errors };
    }

    const mediaErrors = validateAgainstMediaItems(
      normalized.spec,
      input.mediaItems,
      input.referenceMediaIds
    );
    if (mediaErrors.length > 0) {
      return { ok: false, errors: mediaErrors };
    }

    return {
      ok: true,
      spec: normalized.spec,
      brief,
      warnings: normalized.warnings,
      errors: [],
    };
  };

  const firstEval = evaluateOutput(firstRes.text);
  if (firstEval.ok && firstEval.spec) {
    return {
      spec: firstEval.spec,
      brief: firstEval.brief ?? 'Assembled video edit.',
      warnings: firstEval.warnings ?? [],
      calls,
      tokens,
      ms: Math.round(performance.now() - startedAt),
      modelName: firstRes.answeringModel,
      usedBackupModel: firstRes.usedBackup,
    };
  }

  // Call 2: single repair attempt
  onStatus?.('Repairing the spec');
  calls += 1;

  const repairContents: GeminiContent[] = [
    ...contents,
    {
      role: 'model',
      parts: [{ text: firstRes.text }],
    },
    {
      role: 'user',
      parts: [
        {
          text: `Your previous JSON failed validation with these errors:\n${firstEval.errors.join('\n')}\n\nFix ALL errors and return ONLY the corrected EditSpec JSON with "brief". Only use allowed timeline mediaIds from the uploaded media list and stay within each source duration.`,
        },
      ],
    },
  ];

  const repairRes = await callGeminiWithPolicy({
    apiKey,
    modelName,
    backupModelName: input.backupModelName,
    systemInstruction,
    contents: repairContents,
    responseMimeType: 'application/json',
    responseSchema,
    temperature: 0.7,
    maxOutputTokens: 3000,
    thinkingConfig,
    onStatus: input.onGeminiStatus,
    signal,
  });
  addUsageTokens(tokens, repairRes.usageMetadata);

  const secondEval = evaluateOutput(repairRes.text);
  if (secondEval.ok && secondEval.spec) {
    return {
      spec: secondEval.spec,
      brief: secondEval.brief ?? 'Assembled video edit.',
      warnings: secondEval.warnings ?? [],
      calls,
      tokens,
      ms: Math.round(performance.now() - startedAt),
      modelName: repairRes.answeringModel,
      usedBackupModel: firstRes.usedBackup || repairRes.usedBackup,
    };
  }

  throw new Error(
    `AI Edit Director failed validation after repair attempt: ${secondEval.errors.join('; ')}`
  );
}

