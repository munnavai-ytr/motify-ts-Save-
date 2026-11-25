import { z } from 'zod';
import {
  buildThinkingConfig,
  type GeminiContentPart,
  type GeminiStatusEvent,
} from '@/lib/ai/gemini-client';
import { callGeminiWithPolicy } from '@/lib/ai/gemini-policy';
import { extractJsonFromText } from '@/lib/ai/plan-schema';
import type { GeminiUsageMetadata } from '@/lib/types';
import { ANALYZER_PROMPT } from './analyzer-prompt';
import { extractFrames, probeMedia } from './compositor';

export type AnalyzerItemKind = 'video' | 'image' | 'audio' | 'file';

export type AudioRole = 'voiceover' | 'music' | 'sfx' | 'unknown';

export interface AnalyzerInputItem {
  mediaId: string;
  kind: AnalyzerItemKind;
  name: string;
  blob: Blob;
  frames?: Blob[];
  duration?: number;
}

export interface AnalyzeMediaOptions {
  backupModelName?: string;
  maxFramesPerVideo?: number;
  frameWidth?: number;
  imageMaxSide?: number;
  jpegQuality?: number;
  maxTotalMediaParts?: number;
  maxAudioSeconds?: number;
  maxAudioBytes?: number;
  onStatus?: (event: GeminiStatusEvent) => void;
}

export interface MediaAnalysisItem {
  mediaId: string;
  colors: string[];
  mood: string;
  contentSummary: string;
  pacing?: number;
  transitionStyle?: string;
  colorGrade?: string;
  textStyle?: string;
  audioRole?: AudioRole;
}

export interface MediaAnalysis {
  items: MediaAnalysisItem[];
  overallMood: string;
  suggestedPalette: {
    bg: string;
    text: string;
    accent: string;
  };
  suggestedMusicStyle: string;
  warnings: string[];
  rawResponse: string;
  modelName: string;
  usageMetadata?: GeminiUsageMetadata;
  elapsedMs: number;
}

const DEFAULT_MAX_AUDIO_ANALYZER_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ANALYZER_CHARS = 24_000;
const DEFAULT_MAX_VIDEO_FRAMES = 6;
const AUDIO_ROLES: readonly AudioRole[] = ['voiceover', 'music', 'sfx', 'unknown'];

const RawAnalysisItemSchema = z.object({
  mediaId: z.string().trim().min(1),
  colors: z.array(z.string().trim()).min(1).max(6).default(['#0F172A']),
  mood: z.string().trim().min(1).default('neutral'),
  contentSummary: z.string().trim().min(1).default('Uploaded media item'),
  pacing: z.union([z.number(), z.string()]).nullable().optional(),
  transitionStyle: z.string().trim().nullable().optional(),
  colorGrade: z.string().trim().nullable().optional(),
  textStyle: z.string().trim().nullable().optional(),
  audioRole: z.string().trim().nullable().optional(),
});

const RawAnalysisPayloadSchema = z.object({
  items: z.array(RawAnalysisItemSchema).default([]),
  overallMood: z.string().trim().min(1).default('balanced'),
  suggestedPalette: z
    .object({
      bg: z.string().trim().default('#0B0F17'),
      text: z.string().trim().default('#F8FAFC'),
      accent: z.string().trim().default('#38BDF8'),
    })
    .default({
      bg: '#0B0F17',
      text: '#F8FAFC',
      accent: '#38BDF8',
    }),
  suggestedMusicStyle: z.string().trim().default('upbeat-pop'),
});

const ANALYZER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  required: [
    'items',
    'overallMood',
    'suggestedPalette',
    'suggestedMusicStyle',
  ],
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['mediaId', 'colors', 'mood', 'contentSummary'],
        properties: {
          mediaId: { type: 'STRING', nullable: false },
          colors: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          mood: { type: 'STRING', nullable: false },
          contentSummary: { type: 'STRING', nullable: false },
          pacing: { type: 'NUMBER', nullable: true },
          transitionStyle: { type: 'STRING', nullable: true },
          colorGrade: { type: 'STRING', nullable: true },
          textStyle: { type: 'STRING', nullable: true },
          audioRole: {
            type: 'STRING',
            enum: ['voiceover', 'music', 'sfx', 'unknown'],
            nullable: true,
          },
        },
      },
    },
    overallMood: { type: 'STRING', nullable: false },
    suggestedPalette: {
      type: 'OBJECT',
      required: ['bg', 'text', 'accent'],
      properties: {
        bg: { type: 'STRING', nullable: false },
        text: { type: 'STRING', nullable: false },
        accent: { type: 'STRING', nullable: false },
      },
    },
    suggestedMusicStyle: { type: 'STRING', nullable: false },
  },
};

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return uint8ToBase64(new Uint8Array(buf));
}

function inferMimeType(blob: Blob, name: string, fallback: string): string {
  if (blob.type && blob.type.trim().length > 0) {
    return blob.type;
  }
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  return fallback;
}

function pickEvenlySpacedFrames(frames: Blob[], maxCount: number): Blob[] {
  if (frames.length <= maxCount) return frames;
  const result: Blob[] = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.min(
      frames.length - 1,
      Math.floor((i * frames.length) / maxCount)
    );
    result.push(frames[idx]);
  }
  return result;
}

function computeFrameTimestamps(durationSeconds: number, count: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0.1) {
    return [0];
  }
  const safeCount = Math.max(1, count);
  const timestamps: number[] = [];
  for (let i = 0; i < safeCount; i++) {
    const frac = (i + 0.5) / safeCount;
    const ts = Math.min(
      Math.max(0, durationSeconds - 0.05),
      Math.max(0, durationSeconds * frac)
    );
    timestamps.push(Number(ts.toFixed(2)));
  }
  return timestamps;
}

async function resizeImageBlobToJpeg(
  blob: Blob,
  maxLongSide: number | undefined,
  quality: number
): Promise<{ blob: Blob; mimeType: string }> {
  if (
    !maxLongSide ||
    typeof document === 'undefined' ||
    blob.type === 'image/svg+xml'
  ) {
    return { blob, mimeType: blob.type || 'image/jpeg' };
  }

  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      });
      try {
        const srcW = Math.max(1, bitmap.width);
        const srcH = Math.max(1, bitmap.height);
        const longSide = Math.max(srcW, srcH);
        const scale = longSide > maxLongSide ? maxLongSide / longSide : 1;
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(srcH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return { blob, mimeType: blob.type || 'image/jpeg' };
        }
        ctx.drawImage(bitmap, 0, 0, w, h);
        const encoded = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((out) => resolve(out), 'image/jpeg', quality);
        });
        if (encoded && encoded.size > 0) {
          return { blob: encoded, mimeType: 'image/jpeg' };
        }
      } finally {
        bitmap.close();
      }
    }
  } catch {
    // Fall back to original blob if decoding or canvas fails
  }
  return { blob, mimeType: blob.type || 'image/jpeg' };
}

function normalizeAudioRole(raw: string | null | undefined): AudioRole | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if ((AUDIO_ROLES as readonly string[]).includes(normalized)) {
    return normalized as AudioRole;
  }
  return undefined;
}

function normalizePacingValue(raw: number | string | null | undefined): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
    if (trimmed === 'slow') return 0.3;
    if (trimmed === 'medium') return 1.0;
    if (trimmed === 'fast') return 2.0;
  }
  return undefined;
}

export async function analyzeMedia(
  items: AnalyzerInputItem[],
  apiKey: string,
  modelName: string,
  signal?: AbortSignal,
  options?: AnalyzeMediaOptions
): Promise<MediaAnalysis> {
  if (items.length === 0) {
    throw new Error('At least one media item is required for analysis.');
  }

  const maxFramesPerVideo = Math.max(
    1,
    options?.maxFramesPerVideo ?? DEFAULT_MAX_VIDEO_FRAMES
  );
  const jpegQuality = options?.jpegQuality ?? 0.75;
  const maxAudioBytes = options?.maxAudioBytes ?? DEFAULT_MAX_AUDIO_ANALYZER_BYTES;
  const maxAudioSeconds = options?.maxAudioSeconds;
  const maxTotalParts = options?.maxTotalMediaParts;

  // Allocate video frame counts proportionally when a strict total media-part cap is active
  const videoCount = items.filter((i) => i.kind === 'video').length;
  const imageCount = items.filter((i) => i.kind === 'image').length;
  const eligibleAudioCount = items.filter(
    (i) =>
      i.kind === 'audio' &&
      i.blob.size <= maxAudioBytes &&
      (maxAudioSeconds === undefined ||
        i.duration === undefined ||
        i.duration <= maxAudioSeconds)
  ).length;

  let perVideoFrameCap = maxFramesPerVideo;
  if (maxTotalParts !== undefined && videoCount > 0) {
    const reserved = imageCount + eligibleAudioCount;
    const remaining = Math.max(videoCount, maxTotalParts - reserved);
    perVideoFrameCap = Math.max(
      1,
      Math.min(maxFramesPerVideo, Math.floor(remaining / videoCount))
    );
  }

  const parts: GeminiContentPart[] = [];
  const warnings: string[] = [];
  let inlinePartsCount = 0;

  for (const item of items) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (item.kind === 'image') {
      const canInline =
        maxTotalParts === undefined || inlinePartsCount < maxTotalParts;
      if (!canInline) {
        warnings.push(
          `Skipped inline preview of image "${item.name}" to stay within the ${maxTotalParts}-part media cap.`
        );
        parts.push({
          text: `Image item (preview omitted due to budget): mediaId="${item.mediaId}", name="${item.name}"`,
        });
        continue;
      }

      const resized = await resizeImageBlobToJpeg(
        item.blob,
        options?.imageMaxSide,
        jpegQuality
      );
      const mimeType = inferMimeType(resized.blob, item.name, resized.mimeType);
      const data = await blobToBase64(resized.blob);
      parts.push({
        text: `Image item: mediaId="${item.mediaId}", name="${item.name}"`,
      });
      parts.push({
        inlineData: { mimeType, data },
      });
      inlinePartsCount += 1;
    } else if (item.kind === 'video') {
      let duration =
        typeof item.duration === 'number' && Number.isFinite(item.duration)
          ? item.duration
          : 0;
      const effectiveFrameTarget =
        maxTotalParts !== undefined
          ? Math.max(0, Math.min(perVideoFrameCap, maxTotalParts - inlinePartsCount))
          : perVideoFrameCap;

      let frames = item.frames
        ? pickEvenlySpacedFrames(item.frames, Math.max(1, effectiveFrameTarget))
        : [];

      if (duration <= 0 || (frames.length === 0 && effectiveFrameTarget > 0)) {
        if (duration <= 0) {
          const probe = await probeMedia(item.blob);
          duration = probe.duration;
        }
        if (frames.length === 0 && effectiveFrameTarget > 0) {
          const timestamps = computeFrameTimestamps(
            duration,
            Math.max(1, effectiveFrameTarget)
          );
          frames = await extractFrames(item.blob, timestamps);
        }
      }

      const cappedFrames =
        effectiveFrameTarget > 0 ? frames.slice(0, effectiveFrameTarget) : [];
      const durationLabel = duration > 0 ? duration.toFixed(1) : 'unknown';
      parts.push({
        text: `Video: ${item.name}, duration: ${durationLabel}s (mediaId="${item.mediaId}")`,
      });

      for (const frame of cappedFrames) {
        const resized = await resizeImageBlobToJpeg(
          frame,
          options?.frameWidth,
          jpegQuality
        );
        const mimeType = resized.mimeType || frame.type || 'image/jpeg';
        const data = await blobToBase64(resized.blob);
        parts.push({
          inlineData: { mimeType, data },
        });
        inlinePartsCount += 1;
      }
    } else if (item.kind === 'audio') {
      const durationLabel =
        typeof item.duration === 'number' &&
        Number.isFinite(item.duration) &&
        item.duration > 0
          ? `${item.duration.toFixed(1)}s`
          : 'unknown';
      const tooLarge = item.blob.size > maxAudioBytes;
      const tooLong =
        maxAudioSeconds !== undefined &&
        typeof item.duration === 'number' &&
        Number.isFinite(item.duration) &&
        item.duration > maxAudioSeconds;
      const overPartCap =
        maxTotalParts !== undefined && inlinePartsCount >= maxTotalParts;

      if (tooLarge || tooLong || overPartCap) {
        const mb = (item.blob.size / (1024 * 1024)).toFixed(1);
        const reason = tooLong
          ? `${durationLabel} exceeds ${maxAudioSeconds}s inline analyzer limit`
          : tooLarge
            ? `${mb} MB exceeds ${(maxAudioBytes / (1024 * 1024)).toFixed(1)} MB analyzer limit`
            : `media-part cap (${maxTotalParts}) reached`;
        warnings.push(
          `Audio "${item.name}" analyzed by metadata only (${reason}); still available for timeline placement.`
        );
        parts.push({
          text: `Audio item (binary omitted — ${reason}): mediaId="${item.mediaId}", name="${item.name}", duration=${durationLabel}`,
        });
      } else {
        const mimeType = inferMimeType(item.blob, item.name, 'audio/mpeg');
        const data = await blobToBase64(item.blob);
        parts.push({
          text: `Audio item: mediaId="${item.mediaId}", name="${item.name}", duration=${durationLabel}`,
        });
        parts.push({
          inlineData: { mimeType, data },
        });
        inlinePartsCount += 1;
      }
    } else {
      const rawText = await item.blob.text();
      const excerpt =
        rawText.length > MAX_TEXT_ANALYZER_CHARS
          ? `${rawText.slice(0, MAX_TEXT_ANALYZER_CHARS)}\n[truncated]`
          : rawText;
      parts.push({
        text: `File item: mediaId="${item.mediaId}", name="${item.name}"\n${excerpt}`,
      });
    }
  }

  parts.push({
    text: 'Analyze all uploaded items above and return the MediaAnalysis JSON.',
  });

  const result = await callGeminiWithPolicy({
    apiKey,
    modelName,
    backupModelName: options?.backupModelName,
    systemInstruction: ANALYZER_PROMPT,
    contents: [{ role: 'user', parts }],
    responseMimeType: 'application/json',
    responseSchema: ANALYZER_RESPONSE_SCHEMA,
    temperature: 0.3,
    thinkingConfig: buildThinkingConfig(modelName),
    onStatus: options?.onStatus,
    signal,
  });

  const parsedRaw = extractJsonFromText(result.text);
  const validated = RawAnalysisPayloadSchema.parse(parsedRaw);

  const normalizedItems: MediaAnalysisItem[] = validated.items.map((entry) => {
    const pacing = normalizePacingValue(entry.pacing);
    const audioRole = normalizeAudioRole(entry.audioRole);
    return {
      mediaId: entry.mediaId,
      colors: entry.colors.slice(0, 3),
      mood: entry.mood,
      contentSummary: entry.contentSummary,
      ...(pacing !== undefined ? { pacing } : {}),
      ...(entry.transitionStyle ? { transitionStyle: entry.transitionStyle } : {}),
      ...(entry.colorGrade ? { colorGrade: entry.colorGrade } : {}),
      ...(entry.textStyle ? { textStyle: entry.textStyle } : {}),
      ...(audioRole ? { audioRole } : {}),
    };
  });

  return {
    items: normalizedItems,
    overallMood: validated.overallMood,
    suggestedPalette: validated.suggestedPalette,
    suggestedMusicStyle: validated.suggestedMusicStyle,
    warnings,
    rawResponse: result.text,
    modelName: result.answeringModel,
    usageMetadata: result.usageMetadata,
    elapsedMs: result.elapsedMs,
  };
}

