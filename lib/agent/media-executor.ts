import { isAbortError, type GeminiStatusEvent } from '@/lib/ai/gemini-client';
import { extractJsonFromText } from '@/lib/ai/plan-schema';
import type { RouteTurnResult } from '@/lib/agent/media-router';
import { exportCompositionToMp4 } from '@/lib/export';
import {
  containsBengali,
  ensureFonts,
  getSpecDimensions,
  MIN_SCENE_DUR_SEC,
  normalizeVideoSpec,
  totalFrames,
  VideoFromSpec,
  type VideoSpec,
} from '@/lib/kit';
import {
  analyzeMedia,
  type AnalyzerInputItem,
  type MediaAnalysis,
} from '@/lib/media/analyzer';
import { isOutOfMemoryError, renderEditSpec } from '@/lib/media/compositor';
import { generateEditSpec, type MediaItem } from '@/lib/media/edit-director';
import {
  EDIT_SPEC_FPS,
  MAX_AV_TRACKS,
  MAX_TIMELINE_SECONDS,
  normalizeEditSpec,
  type AudioTrack,
  type EditFormat,
  type EditSpec,
  type MGTrack,
  type OverlayTrack,
  type Track,
  type VideoTrack,
} from '@/lib/media/edit-types';
import {
  getLoadState,
  loadFFmpeg,
  onProgress as subscribeFFmpegLoadProgress,
} from '@/lib/media/ffmpeg-loader';
import {
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_VIDEO_BYTES,
} from '@/lib/media/process';
import type {
  FormatPreference,
  MediaRecord,
  MediaVideoMessage,
  RunStepId,
  RunStepStatus,
  VideoFormat,
} from '@/lib/types';

export const CHAT_ANALYSIS_BUDGET = {
  maxFramesPerVideo: 4,
  frameWidth: 512,
  imageMaxSide: 768,
  jpegQuality: 0.7,
  maxTotalMediaParts: 12,
  maxAudioSeconds: 90,
  maxAudioBytes: 5 * 1024 * 1024,
} as const;

const MAX_HYBRID_MG_SEGMENTS = 2;
const MAX_HYBRID_MG_DURATION_SEC = 5;
const LOW_MEMORY_GB_THRESHOLD = 4;
const LOW_MEMORY_SINGLE_VIDEO_WARN_BYTES = 100 * 1024 * 1024;
const LOW_MEMORY_TOTAL_WARN_BYTES = 250 * 1024 * 1024;

export interface MediaUsageDelta {
  requestsMade: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  modelName: string;
  usedBackup?: boolean;
}

export interface RunMediaTurnParams {
  userPrompt: string;
  mediaRecords: MediaRecord[];
  newAttachmentCount?: number;
  format: FormatPreference;
  language: 'en' | 'bn' | 'auto';
  apiKey: string;
  modelName: string;
  backupModelName?: string;
  route: RouteTurnResult;
  existingMediaVideo?: MediaVideoMessage | null;
  signal?: AbortSignal;
  onStep?: (
    stepId: RunStepId,
    status: RunStepStatus,
    detail?: string,
    label?: string
  ) => void;
  onSubNote?: (stepId: RunStepId | null, note: string) => void;
  onUsage?: (delta: MediaUsageDelta) => void;
  onStatus?: (event: GeminiStatusEvent) => void;
}

export interface MediaTurnResult {
  editSpec: EditSpec;
  analysis: MediaAnalysis | null;
  mp4Blob: Blob;
  thumbBlob?: Blob;
  durationSec: number;
  format: VideoFormat;
  brief: string;
  usedMediaIds: string[];
  warnings: string[];
  calls: number;
  tokens: {
    prompt: number;
    output: number;
    thinking: number;
  };
  modelName: string;
  usedBackupModel: boolean;
  elapsedMs: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function resolveEditFormat(
  preference: FormatPreference,
  mediaRecords: ReadonlyArray<MediaRecord>,
  referenceIds: ReadonlyArray<string>,
  existingFormat?: VideoFormat
): EditFormat {
  if (preference !== 'auto') {
    return preference;
  }
  const refSet = new Set(referenceIds);
  const firstVisual =
    mediaRecords.find(
      (r) => !refSet.has(r.id) && (r.kind === 'video' || r.kind === 'image')
    ) ?? mediaRecords.find((r) => r.kind === 'video' || r.kind === 'image');

  if (
    firstVisual &&
    typeof firstVisual.width === 'number' &&
    typeof firstVisual.height === 'number' &&
    firstVisual.width > 0 &&
    firstVisual.height > 0
  ) {
    const ratio = firstVisual.width / firstVisual.height;
    if (ratio >= 1.15) return '16:9';
    if (ratio <= 0.85) return '9:16';
    return '1:1';
  }

  if (existingFormat) {
    return existingFormat;
  }
  return '9:16';
}

function parseTargetSecondsFromPrompt(prompt: string): number | null {
  const match =
    /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|সেকেন্ড)\b/i.exec(prompt);
  if (!match) return null;
  const val = Number(match[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  return Math.max(3, Math.min(MAX_TIMELINE_SECONDS, Math.round(val)));
}

function resolveTargetSeconds(
  prompt: string,
  mediaRecords: ReadonlyArray<MediaRecord>,
  analysis: MediaAnalysis | null,
  referenceIds: ReadonlyArray<string>,
  existingSpec?: EditSpec
): number {
  const explicit = parseTargetSecondsFromPrompt(prompt);
  if (explicit !== null) {
    return explicit;
  }

  const voiceoverIds = new Set(
    (analysis?.items ?? [])
      .filter((item) => item.audioRole === 'voiceover')
      .map((item) => item.mediaId)
  );
  const voiceoverRecord = mediaRecords.find(
    (r) =>
      r.kind === 'audio' &&
      voiceoverIds.has(r.id) &&
      typeof r.duration === 'number' &&
      r.duration > 0
  );
  if (voiceoverRecord?.duration) {
    return Math.min(
      MAX_TIMELINE_SECONDS,
      Math.max(3, Math.ceil(voiceoverRecord.duration))
    );
  }

  if (existingSpec && existingSpec.totalSeconds > 0) {
    return Math.min(MAX_TIMELINE_SECONDS, existingSpec.totalSeconds);
  }

  const refSet = new Set(referenceIds);
  let timelineSum = 0;
  for (const rec of mediaRecords) {
    if (refSet.has(rec.id)) continue;
    if (rec.kind === 'video') {
      timelineSum +=
        typeof rec.duration === 'number' && rec.duration > 0
          ? rec.duration
          : 5;
    } else if (rec.kind === 'image') {
      timelineSum += 3.5;
    }
  }

  if (timelineSum <= 0) {
    return 15;
  }
  if (timelineSum < 8) {
    return Math.max(3, Math.round(timelineSum * 10) / 10);
  }
  return Math.min(45, Math.round(timelineSum));
}

function toAnalyzerInputItems(
  mediaRecords: ReadonlyArray<MediaRecord>
): AnalyzerInputItem[] {
  return mediaRecords.map((rec) => {
    if (rec.kind === 'video') {
      return {
        mediaId: rec.id,
        kind: 'video',
        name: rec.name,
        blob: rec.blob,
        ...(rec.frames && rec.frames.length > 0 ? { frames: rec.frames } : {}),
        ...(typeof rec.duration === 'number' ? { duration: rec.duration } : {}),
      };
    }
    if (rec.kind === 'image') {
      return {
        mediaId: rec.id,
        kind: 'image',
        name: rec.name,
        blob: rec.aiBlob ?? rec.blob,
      };
    }
    if (rec.kind === 'audio') {
      return {
        mediaId: rec.id,
        kind: 'audio',
        name: rec.name,
        blob: rec.blob,
        ...(typeof rec.duration === 'number' ? { duration: rec.duration } : {}),
      };
    }
    const textBody =
      rec.textContent && rec.textContent.trim().length > 0
        ? rec.textContent
        : `[${rec.kind.toUpperCase()} attachment: ${rec.name}, ${formatBytes(rec.size)}]`;
    return {
      mediaId: rec.id,
      kind: 'file',
      name: rec.name,
      blob: new Blob([textBody], { type: 'text/plain' }),
    };
  });
}

function toDirectorMediaItems(
  mediaRecords: ReadonlyArray<MediaRecord>
): MediaItem[] {
  return mediaRecords.map((rec) => ({
    id: rec.id,
    mediaId: rec.id,
    kind: rec.kind,
    name: rec.name,
    size: rec.size,
    ...(typeof rec.duration === 'number' ? { duration: rec.duration } : {}),
    ...(typeof rec.width === 'number' ? { width: rec.width } : {}),
    ...(typeof rec.height === 'number' ? { height: rec.height } : {}),
  }));
}

function clampHybridKitSpec(
  rawSpec: VideoSpec,
  format: EditFormat,
  maxDurationSec: number
): VideoSpec {
  const clampedTarget = Math.min(
    MAX_HYBRID_MG_DURATION_SEC,
    Math.max(MIN_SCENE_DUR_SEC, maxDurationSec)
  );
  const baseScenes = rawSpec.scenes.slice(0, 2);
  const currentTotal = baseScenes.reduce((sum, s) => sum + s.dur, 0);

  let scenes = baseScenes;
  if (scenes.length > 1 && clampedTarget < MIN_SCENE_DUR_SEC * 2) {
    scenes = [
      {
        ...scenes[0],
        dur: Math.round(clampedTarget * 10) / 10,
      },
    ];
  } else if (currentTotal > clampedTarget && currentTotal > 0) {
    const ratio = clampedTarget / currentTotal;
    scenes = scenes.map((sc) => ({
      ...sc,
      dur: Math.max(
        MIN_SCENE_DUR_SEC,
        Math.round(sc.dur * ratio * 10) / 10
      ),
    }));
  }

  return {
    ...rawSpec,
    format,
    fps: EDIT_SPEC_FPS,
    audio: { sfx: 'off', mute: true },
    scenes,
  };
}

async function renderHybridMGTrack(
  mgTrack: MGTrack,
  index: number,
  format: EditFormat,
  signal: AbortSignal | undefined,
  onProgressPct: (pct: number) => void
): Promise<{ blob: Blob; durationSec: number }> {
  if (typeof document === 'undefined') {
    throw new Error('Hybrid motion graphic rendering requires a browser.');
  }

  const parsedRaw = extractJsonFromText(mgTrack.specJson);
  const normalized = normalizeVideoSpec(parsedRaw);
  if (!normalized.ok) {
    throw new Error(
      `Invalid hybrid motion-graphic spec: ${normalized.errors.join('; ')}`
    );
  }

  const kitSpec = clampHybridKitSpec(
    normalized.spec,
    format,
    mgTrack.duration
  );
  const hasBengali = containsBengali(JSON.stringify(kitSpec.scenes));
  await ensureFonts({ timeoutMs: 4500, hasBengali });
  throwIfAborted(signal);

  const dims = getSpecDimensions(kitSpec);
  const frames = totalFrames(kitSpec);
  const durationSec = Math.max(
    MIN_SCENE_DUR_SEC,
    Math.round((frames / EDIT_SPEC_FPS) * 100) / 100
  );

  const exported = await exportCompositionToMp4({
    compositionId: `hybrid-mg-${index + 1}`,
    component: VideoFromSpec,
    inputProps: { spec: kitSpec, disableAudio: true },
    spec: kitSpec,
    durationInFrames: frames,
    fps: EDIT_SPEC_FPS,
    width: dims.width,
    height: dims.height,
    mode: 'compatibility',
    muted: true,
    signal,
    onProgress: (p) => {
      onProgressPct(p.progressPercent);
    },
  });

  return { blob: exported.blob, durationSec };
}

async function extractThumbnailFromVideoBlob(
  videoBlob: Blob
): Promise<Blob | undefined> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return undefined;
  }
  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Thumbnail load timeout'));
      }, 6000);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Thumbnail load error'));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    const dur =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const seekTime = dur > 0 ? Math.min(0.8, dur * 0.25) : 0;

    if (seekTime > 0) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 2500);
        const onSeeked = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        try {
          video.currentTime = seekTime;
        } catch {
          window.clearTimeout(timer);
          resolve();
        }
      });
    }

    const srcW = video.videoWidth || 720;
    const srcH = video.videoHeight || 1280;
    const maxSide = 480;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    });
    return blob && blob.size > 0 ? blob : undefined;
  } catch {
    return undefined;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function runMediaTurn(
  params: RunMediaTurnParams
): Promise<MediaTurnResult> {
  const startedAt = performance.now();
  const warnings: string[] = [];
  const totalTokens = { prompt: 0, output: 0, thinking: 0 };
  let totalCalls = 0;
  let lastAnsweringModel = params.modelName;
  let usedBackupModel = false;

  // Deduplicate records while preserving order
  const uniqueRecords: MediaRecord[] = [];
  const seenIds = new Set<string>();
  for (const rec of params.mediaRecords) {
    if (!seenIds.has(rec.id)) {
      seenIds.add(rec.id);
      uniqueRecords.push(rec);
    }
  }

  // Hard caps before starting
  if (
    params.newAttachmentCount !== undefined &&
    params.newAttachmentCount > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    throw new Error(
      `You attached ${params.newAttachmentCount} files in one message; please attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} items per edit.`
    );
  }

  let totalMediaBytes = 0;
  let maxSingleVideoBytes = 0;
  for (const rec of uniqueRecords) {
    totalMediaBytes += rec.size;
    if (rec.kind === 'video') {
      if (rec.size > MAX_VIDEO_BYTES) {
        throw new Error(
          `Video "${rec.name}" (${formatBytes(rec.size)}) exceeds the ${formatBytes(MAX_VIDEO_BYTES)} limit. Please trim or compress it first.`
        );
      }
      if (rec.size > maxSingleVideoBytes) {
        maxSingleVideoBytes = rec.size;
      }
    }
  }

  if (uniqueRecords.length === 0) {
    throw new Error(
      'No media files were found for this edit. Attach a video, photo, or audio clip first.'
    );
  }

  // Memory guard for low-memory browsers (<= 4 GB)
  const deviceMemoryGb =
    typeof navigator !== 'undefined'
      ? (navigator as { deviceMemory?: number }).deviceMemory
      : undefined;
  if (
    typeof deviceMemoryGb === 'number' &&
    deviceMemoryGb <= LOW_MEMORY_GB_THRESHOLD &&
    (maxSingleVideoBytes > LOW_MEMORY_SINGLE_VIDEO_WARN_BYTES ||
      totalMediaBytes > LOW_MEMORY_TOTAL_WARN_BYTES)
  ) {
    const memWarn = `This device reports ${deviceMemoryGb} GB RAM and your media totals ${formatBytes(totalMediaBytes)}; long or multi-clip renders may hit browser memory limits.`;
    warnings.push(memWarn);
    params.onSubNote?.(null, memWarn);
  }

  // (a) Vision Analysis (reusing existing analysis on text-only follow-up edits)
  let analysis: MediaAnalysis | null = null;
  const canReuseExistingAnalysis =
    params.route.editExisting &&
    Boolean(params.existingMediaVideo?.analysis) &&
    (params.newAttachmentCount ?? 0) === 0;

  if (canReuseExistingAnalysis) {
    analysis = params.existingMediaVideo?.analysis ?? null;
  } else {
    params.onStep?.('analyze', 'running');
    try {
      const analyzerItems = toAnalyzerInputItems(uniqueRecords);
      analysis = await analyzeMedia(
        analyzerItems,
        params.apiKey,
        params.modelName,
        params.signal,
        {
          backupModelName: params.backupModelName,
          maxFramesPerVideo: CHAT_ANALYSIS_BUDGET.maxFramesPerVideo,
          frameWidth: CHAT_ANALYSIS_BUDGET.frameWidth,
          imageMaxSide: CHAT_ANALYSIS_BUDGET.imageMaxSide,
          jpegQuality: CHAT_ANALYSIS_BUDGET.jpegQuality,
          maxTotalMediaParts: CHAT_ANALYSIS_BUDGET.maxTotalMediaParts,
          maxAudioSeconds: CHAT_ANALYSIS_BUDGET.maxAudioSeconds,
          maxAudioBytes: CHAT_ANALYSIS_BUDGET.maxAudioBytes,
          onStatus: (ev) => {
            if (ev.type === 'attempt') {
              lastAnsweringModel = ev.model;
              if (ev.isBackup) usedBackupModel = true;
            } else if (ev.type === 'fallback') {
              lastAnsweringModel = ev.toModel;
              usedBackupModel = true;
            }
            params.onStatus?.(ev);
          },
        }
      );
      totalCalls += 1;
      lastAnsweringModel = analysis.modelName || lastAnsweringModel;
      const pTok = analysis.usageMetadata?.promptTokenCount ?? 0;
      const oTok = analysis.usageMetadata?.candidatesTokenCount ?? 0;
      const tTok = analysis.usageMetadata?.thoughtsTokenCount ?? 0;
      totalTokens.prompt += pTok;
      totalTokens.output += oTok;
      totalTokens.thinking += tTok;

      params.onUsage?.({
        requestsMade: 1,
        promptTokens: pTok,
        outputTokens: oTok,
        thoughtTokens: tTok,
        modelName: lastAnsweringModel,
        usedBackup: usedBackupModel,
      });

      for (const w of analysis.warnings) {
        warnings.push(w);
        params.onSubNote?.('analyze', w);
      }

      params.onStep?.('analyze', 'done');
    } catch (err: unknown) {
      if (isAbortError(err) || params.signal?.aborted) {
        throw err;
      }
      params.onStep?.('analyze', 'failed');
      throw err;
    }
  }

  throwIfAborted(params.signal);

  // (b) Plan the EditSpec via AI Edit Director
  params.onStep?.('plan_edit', 'running');
  const resolvedFormat = resolveEditFormat(
    params.format,
    uniqueRecords,
    params.route.referenceMediaIds,
    params.existingMediaVideo?.format
  );
  const targetSeconds = resolveTargetSeconds(
    params.userPrompt,
    uniqueRecords,
    analysis,
    params.route.referenceMediaIds,
    params.route.editExisting ? params.existingMediaVideo?.editSpec : undefined
  );

  let directorResult: Awaited<ReturnType<typeof generateEditSpec>>;
  try {
    directorResult = await generateEditSpec(
      {
        userRequest: params.userPrompt,
        mediaItems: toDirectorMediaItems(uniqueRecords),
        analysis,
        format: resolvedFormat,
        targetSeconds,
        language: params.language,
        referenceOnly: params.route.referenceOnly,
        referenceMediaIds: params.route.referenceMediaIds,
        existingEditSpec: params.route.editExisting
          ? params.existingMediaVideo?.editSpec
          : undefined,
        allowHybridMG: params.route.route === 'hybrid',
        backupModelName: params.backupModelName,
        onGeminiStatus: (ev) => {
          if (ev.type === 'attempt') {
            lastAnsweringModel = ev.model;
            if (ev.isBackup) usedBackupModel = true;
          } else if (ev.type === 'fallback') {
            lastAnsweringModel = ev.toModel;
            usedBackupModel = true;
          }
          params.onStatus?.(ev);
        },
      },
      params.apiKey,
      params.modelName,
      params.signal,
      (status) => {
        if (status === 'Repairing the spec') {
          params.onSubNote?.('plan_edit', 'Repairing edit timeline spec...');
        }
      }
    );

    totalCalls += directorResult.calls;
    totalTokens.prompt += directorResult.tokens.prompt;
    totalTokens.output += directorResult.tokens.output;
    totalTokens.thinking += directorResult.tokens.thinking;
    if (directorResult.modelName) {
      lastAnsweringModel = directorResult.modelName;
    }
    if (directorResult.usedBackupModel) {
      usedBackupModel = true;
    }

    params.onUsage?.({
      requestsMade: directorResult.calls,
      promptTokens: directorResult.tokens.prompt,
      outputTokens: directorResult.tokens.output,
      thoughtTokens: directorResult.tokens.thinking,
      modelName: lastAnsweringModel,
      usedBackup: usedBackupModel,
    });

    for (const w of directorResult.warnings) {
      warnings.push(w);
    }

    params.onStep?.('plan_edit', 'done');
  } catch (err: unknown) {
    if (isAbortError(err) || params.signal?.aborted) {
      throw err;
    }
    params.onStep?.('plan_edit', 'failed');
    throw err;
  }

  throwIfAborted(params.signal);

  // (c) Validate EditSpec & build media blob map
  params.onStep?.('check_edit', 'running');
  const plannedSpec = directorResult.spec;
  const referenceSet = new Set(params.route.referenceMediaIds);
  const mediaBlobs = new Map<string, Blob>();
  for (const rec of uniqueRecords) {
    if (!referenceSet.has(rec.id)) {
      mediaBlobs.set(rec.id, rec.blob);
    }
  }

  const usedMediaIdsSet = new Set<string>();
  for (const track of plannedSpec.tracks) {
    if (track.kind === 'mg') continue;
    if (!mediaBlobs.has(track.mediaId)) {
      params.onStep?.('check_edit', 'failed');
      throw new Error(
        `Edit timeline references missing or excluded media "${track.mediaId}".`
      );
    }
    usedMediaIdsSet.add(track.mediaId);
  }
  params.onStep?.('check_edit', 'done');

  throwIfAborted(params.signal);

  // (d) Render Hybrid MG segments (if any) into MP4 blobs & swap into VideoTracks
  const mgTracks = plannedSpec.tracks.filter(
    (t): t is MGTrack => t.kind === 'mg'
  );
  let executableSpec: EditSpec = plannedSpec;

  if (mgTracks.length > 0) {
    params.onStep?.('design', 'running');
    const keptMgTracks = mgTracks.slice(0, MAX_HYBRID_MG_SEGMENTS);
    if (mgTracks.length > MAX_HYBRID_MG_SEGMENTS) {
      const capWarn = `Capped motion-graphic title segments to ${MAX_HYBRID_MG_SEGMENTS}.`;
      warnings.push(capWarn);
      params.onSubNote?.('design', capWarn);
    }

    const renderedMgTracks: VideoTrack[] = [];
    for (let i = 0; i < keptMgTracks.length; i++) {
      throwIfAborted(params.signal);
      const mg = keptMgTracks[i];
      try {
        const rendered = await renderHybridMGTrack(
          mg,
          i,
          plannedSpec.format,
          params.signal,
          (pct) => {
            params.onSubNote?.(
              'design',
              `Motion graphic ${i + 1}/${keptMgTracks.length}: ${pct}%`
            );
          }
        );
        const mgMediaId = `__mg_${i + 1}`;
        mediaBlobs.set(mgMediaId, rendered.blob);
        renderedMgTracks.push({
          kind: 'video',
          mediaId: mgMediaId,
          startAt: mg.startAt,
          inPoint: 0,
          outPoint: rendered.durationSec,
          volume: 0,
          fit: 'cover',
        });
      } catch (mgErr: unknown) {
        if (isAbortError(mgErr) || params.signal?.aborted) {
          throw mgErr;
        }
        const reason =
          mgErr instanceof Error ? mgErr.message : String(mgErr);
        const skipWarn = `Skipped motion-graphic segment ${i + 1} (${reason}); continuing with footage.`;
        warnings.push(skipWarn);
        params.onSubNote?.('design', skipWarn);
      }
    }

    const nonMgVideoTracks = plannedSpec.tracks.filter(
      (t): t is VideoTrack => t.kind === 'video'
    );
    const audioTracks = plannedSpec.tracks.filter(
      (t): t is AudioTrack => t.kind === 'audio'
    );
    const overlayTracks = plannedSpec.tracks.filter(
      (t): t is OverlayTrack => t.kind === 'overlay'
    );

    const combinedVideoTracks = [...nonMgVideoTracks, ...renderedMgTracks].sort(
      (a, b) => a.startAt - b.startAt
    );

    if (combinedVideoTracks.length === 0 && audioTracks.length === 0) {
      params.onStep?.('design', 'failed');
      throw new Error(
        'Motion-graphic title segment could not be rendered and no footage tracks remained.'
      );
    }

    // Recompute normalized tracks within MAX_AV_TRACKS
    const trimmedVideo = combinedVideoTracks.slice(
      0,
      Math.max(1, MAX_AV_TRACKS - audioTracks.length)
    );
    const nextTracks: Track[] = [
      ...trimmedVideo,
      ...audioTracks.slice(0, MAX_AV_TRACKS - trimmedVideo.length),
      ...overlayTracks,
    ];

    const reNormalized = normalizeEditSpec({
      ...plannedSpec,
      tracks: nextTracks,
    });
    if (!reNormalized.ok) {
      params.onStep?.('design', 'failed');
      throw new Error(
        `Failed to merge motion-graphic segments into timeline: ${reNormalized.errors.join('; ')}`
      );
    }
    executableSpec = reNormalized.spec;
    params.onStep?.('design', 'done');
  }

  throwIfAborted(params.signal);

  // (e) Load FFmpeg (with download progress) & render final full-res 30fps MP4
  params.onStep?.('render', 'running');
  let unsubscribeFFmpeg: (() => void) | null = null;
  let lastLoggedLoadPct = -10;

  try {
    if (getLoadState() !== 'ready') {
      unsubscribeFFmpeg = subscribeFFmpegLoadProgress((p) => {
        if (p.percent === 100 || p.percent - lastLoggedLoadPct >= 10) {
          lastLoggedLoadPct = p.percent;
          params.onSubNote?.(
            'render',
            `Loading FFmpeg: ${p.percent}% (${p.loadedMB.toFixed(1)} / ${p.totalMB.toFixed(1)} MB)`
          );
        }
      });
      await loadFFmpeg();
    }

    throwIfAborted(params.signal);

    let lastRenderPct = -5;
    const mp4Blob = await renderEditSpec(
      executableSpec,
      mediaBlobs,
      (p) => {
        if (
          p.percent === 100 ||
          p.percent - lastRenderPct >= 5 ||
          p.percent <= 10
        ) {
          lastRenderPct = p.percent;
          params.onSubNote?.('render', `${p.stage} ${p.percent}%`);
        }
      },
      {
        fps: EDIT_SPEC_FPS,
        signal: params.signal,
        onWarning: (w) => {
          warnings.push(w);
          params.onSubNote?.('render', w);
        },
      }
    );

    throwIfAborted(params.signal);

    const thumbBlob = await extractThumbnailFromVideoBlob(mp4Blob);
    params.onStep?.('render', 'done');

    const videoDurationSum = executableSpec.tracks
      .filter((t): t is VideoTrack => t.kind === 'video')
      .reduce(
        (sum, t) => sum + Math.max(0.05, t.outPoint - t.inPoint) / (t.speed ?? 1),
        0
      );
    const durationSec =
      videoDurationSum > 0
        ? Math.min(executableSpec.totalSeconds, videoDurationSum)
        : executableSpec.totalSeconds;

    return {
      editSpec: plannedSpec,
      analysis,
      mp4Blob,
      thumbBlob,
      durationSec: Math.round(durationSec * 10) / 10,
      format: executableSpec.format,
      brief: directorResult.brief,
      usedMediaIds: Array.from(usedMediaIdsSet),
      warnings,
      calls: totalCalls,
      tokens: totalTokens,
      modelName: lastAnsweringModel,
      usedBackupModel,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (err: unknown) {
    if (isAbortError(err) || params.signal?.aborted) {
      throw err;
    }
    params.onStep?.('render', 'failed');
    if (isOutOfMemoryError(err)) {
      throw new Error(
        'The browser ran out of memory while editing. Try fewer or shorter clips.'
      );
    }
    throw err;
  } finally {
    unsubscribeFFmpeg?.();
  }
}
