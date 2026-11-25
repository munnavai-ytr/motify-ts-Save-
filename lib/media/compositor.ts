import type { FFmpeg } from '@ffmpeg/ffmpeg';
import {
  COLOR_GRADES,
  FORMAT_DIMENSIONS,
  MAX_AV_TRACKS,
  MAX_INPUT_VIDEO_BYTES,
  MAX_TIMELINE_SECONDS,
  normalizeEditSpec,
  type AudioTrack,
  type ColorGradePreset,
  type EditSpec,
  type OverlayTrack,
  type VideoTrack,
} from './edit-types';
import { getFFmpeg, getLoadState, loadFFmpeg } from './ffmpeg-loader';

export interface RenderProgress {
  percent: number;
  stage: string;
}

export interface RenderOptions {
  maxWidth?: number;
  fps?: number;
  maxDuration?: number;
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'fast' | 'medium';
  signal?: AbortSignal;
  fontBlob?: Blob;
  onWarning?: (warning: string) => void;
}

export function isOutOfMemoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('out of memory') ||
    msg.includes('oom') ||
    msg.includes('cannot allocate') ||
    msg.includes('allocation failed') ||
    msg.includes('memory access out of bounds') ||
    msg.includes('wasm memory')
  );
}

export interface MediaProbeResult {
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  rawInfo: string;
}

export const COLOR_GRADE_CURVES: Record<ColorGradePreset, string | null> = {
  none: null,
  warm: "curves=r='0/0 0.5/0.58 1/1':g='0/0 0.5/0.51 1/0.98':b='0/0 0.5/0.40 1/0.88'",
  cool: "curves=r='0/0 0.5/0.42 1/0.90':g='0/0 0.5/0.50 1/0.98':b='0/0 0.5/0.58 1/1'",
  vintage:
    "curves=r='0/0.06 0.25/0.26 0.75/0.78 1/0.94':g='0/0.04 0.5/0.50 1/0.92':b='0/0.10 0.5/0.44 1/0.82'",
  noir: "hue=s=0,curves=m='0/0 0.22/0.14 0.5/0.50 0.78/0.86 1/1'",
  vibrant:
    "curves=m='0/0 0.18/0.14 0.5/0.52 0.82/0.87 1/1':r='0/0 0.25/0.22 0.75/0.79 1/1':g='0/0 0.25/0.24 0.75/0.77 1/1':b='0/0 0.25/0.22 0.75/0.80 1/1'",
};

let jobSequence = 0;
let ffmpegQueue: Promise<void> = Promise.resolve();

function withFFmpegLock<T>(task: (ffmpeg: FFmpeg) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (getLoadState() !== 'ready') {
      await loadFFmpeg();
    }
    const ffmpeg = getFFmpeg();
    return task(ffmpeg);
  };

  const result = ffmpegQueue.then(run, run);
  ffmpegQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function nextJobId(): string {
  jobSequence += 1;
  return `job_${Date.now()}_${jobSequence}`;
}

function inferExtension(blob: Blob, fallback: string): string {
  const mime = blob.type.toLowerCase();
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return fallback;
}

function isImageBlob(blob: Blob): boolean {
  return blob.type.toLowerCase().startsWith('image/');
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

function toSafeUint8Array(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') {
    const encoded = new TextEncoder().encode(data);
    return Uint8Array.from(encoded);
  }
  return Uint8Array.from(data);
}

function makeEven(n: number): number {
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function parseTimeSeconds(line: string): number | null {
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function parseProbeLogs(lines: string[]): MediaProbeResult {
  const rawInfo = lines.join('\n');

  let duration = 0;
  const durMatch = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(rawInfo);
  if (durMatch) {
    duration =
      Number(durMatch[1]) * 3600 +
      Number(durMatch[2]) * 60 +
      Number(durMatch[3]);
  }

  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let hasVideo = false;
  let hasAudio = false;

  for (const line of lines) {
    if (line.includes('Video:')) {
      hasVideo = true;
      const codecMatch = /Video:\s*([a-zA-Z0-9_-]+)/.exec(line);
      if (codecMatch) videoCodec = codecMatch[1];

      const resMatch = /(?:^|[,\s])(\d{2,5})x(\d{2,5})(?:[,\s\[]|$)/.exec(line);
      if (resMatch) {
        width = Number(resMatch[1]);
        height = Number(resMatch[2]);
      }

      const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(line);
      if (fpsMatch) {
        fps = Number(fpsMatch[1]);
      }
    } else if (line.includes('Audio:')) {
      hasAudio = true;
      const codecMatch = /Audio:\s*([a-zA-Z0-9_-]+)/.exec(line);
      if (codecMatch) audioCodec = codecMatch[1];
    }
  }

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    fps,
    hasVideo,
    hasAudio,
    videoCodec,
    audioCodec,
    rawInfo,
  };
}

async function probeVirtualFile(
  ffmpeg: FFmpeg,
  filePath: string
): Promise<MediaProbeResult> {
  const logs: string[] = [];
  const onLog = ({ message }: { type: string; message: string }): void => {
    logs.push(message);
  };
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.exec(['-hide_banner', '-i', filePath]);
  } catch {
    // ffmpeg -i without an output returns exit code 1 by design
  } finally {
    ffmpeg.off('log', onLog);
  }
  return parseProbeLogs(logs);
}

export async function probeMedia(mediaBlob: Blob): Promise<MediaProbeResult> {
  return withFFmpegLock(async (ffmpeg) => {
    const jobId = nextJobId();
    const ext = inferExtension(mediaBlob, 'bin');
    const filePath = `${jobId}_probe.${ext}`;
    const bytes = new Uint8Array(await mediaBlob.arrayBuffer());
    await ffmpeg.writeFile(filePath, bytes);
    try {
      return await probeVirtualFile(ffmpeg, filePath);
    } finally {
      await ffmpeg.deleteFile(filePath).catch(() => undefined);
    }
  });
}

function getColorGradeFilter(grade: string | undefined): string | null {
  if (!grade) return null;
  const key = grade.trim().toLowerCase();
  if ((COLOR_GRADES as readonly string[]).includes(key)) {
    return COLOR_GRADE_CURVES[key as ColorGradePreset];
  }
  return null;
}

function computeOverlayX(x: OverlayTrack['x'], margin: number): string {
  switch (x) {
    case 'left':
      return String(margin);
    case 'center':
      return '(W-w)/2';
    case 'right':
      return `W-w-${margin}`;
  }
}

function computeOverlayY(y: OverlayTrack['y'], margin: number): string {
  switch (y) {
    case 'top':
      return String(margin);
    case 'center':
      return '(H-h)/2';
    case 'bottom':
      return `H-h-${margin}`;
  }
}

function resolveOutputDimensions(
  spec: EditSpec,
  options?: RenderOptions
): { width: number; height: number; fps: number } {
  const base = FORMAT_DIMENSIONS[spec.format];
  const fps = options?.fps ?? spec.fps;
  if (!options?.maxWidth || base.width <= options.maxWidth) {
    return { width: base.width, height: base.height, fps };
  }
  const scale = options.maxWidth / base.width;
  return {
    width: makeEven(base.width * scale),
    height: makeEven(base.height * scale),
    fps,
  };
}

export async function renderEditSpec(
  rawSpec: EditSpec,
  mediaBlobs: Map<string, Blob>,
  onProgress: (progress: RenderProgress) => void = () => {},
  options?: RenderOptions
): Promise<Blob> {
  const normalized = normalizeEditSpec(rawSpec);
  if (!normalized.ok) {
    throw new Error(`Invalid EditSpec: ${normalized.errors.join('; ')}`);
  }
  const spec = normalized.spec;

  if (spec.totalSeconds > MAX_TIMELINE_SECONDS) {
    throw new Error(
      `Timeline duration (${spec.totalSeconds}s) exceeds maximum of ${MAX_TIMELINE_SECONDS} seconds.`
    );
  }

  const avTracks = spec.tracks.filter(
    (t): t is VideoTrack | AudioTrack => t.kind === 'video' || t.kind === 'audio'
  );
  if (avTracks.length > MAX_AV_TRACKS) {
    throw new Error(
      `Track limit exceeded: ${avTracks.length} video/audio tracks provided, maximum is ${MAX_AV_TRACKS}.`
    );
  }

  const videoTracks = spec.tracks
    .filter((t): t is VideoTrack => t.kind === 'video')
    .slice()
    .sort((a, b) => a.startAt - b.startAt);
  const audioTracks = spec.tracks
    .filter((t): t is AudioTrack => t.kind === 'audio')
    .slice()
    .sort((a, b) => a.startAt - b.startAt);
  const overlayTracks = spec.tracks
    .filter((t): t is OverlayTrack => t.kind === 'overlay')
    .slice()
    .sort((a, b) => a.startAt - b.startAt);

  // Validate all media blobs exist and enforce size limit before locking FFmpeg
  for (const track of [...videoTracks, ...audioTracks, ...overlayTracks]) {
    const blob = mediaBlobs.get(track.mediaId);
    if (!blob) {
      throw new Error(
        `Missing media blob for mediaId "${track.mediaId}". Provide it in mediaBlobs.`
      );
    }
    if (track.kind === 'video' && blob.size > MAX_INPUT_VIDEO_BYTES) {
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Input video "${track.mediaId}" is ${sizeMB} MB, exceeding the 300 MB limit.`
      );
    }
  }

  const maxDuration = options?.maxDuration;
  const targetTotalSeconds =
    maxDuration !== undefined
      ? Math.min(spec.totalSeconds, maxDuration)
      : spec.totalSeconds;

  const { width, height, fps } = resolveOutputDimensions(spec, options);
  const preset = options?.preset ?? 'ultrafast';

  return withFFmpegLock(async (ffmpeg) => {
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const jobId = nextJobId();
    const writtenFiles: string[] = [];
    const outputPath = `${jobId}_output.mp4`;
    const mediaPathMap = new Map<string, string>();
    const mediaProbeMap = new Map<string, MediaProbeResult>();
    const mediaBlobKindMap = new Map<string, 'image' | 'video' | 'audio'>();

    onProgress({ percent: 2, stage: 'Writing media files...' });

    try {
      // A) Write all unique input blobs to virtual FS
      let fileIndex = 0;
      for (const track of [...videoTracks, ...audioTracks, ...overlayTracks]) {
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (mediaPathMap.has(track.mediaId)) continue;
        const blob = mediaBlobs.get(track.mediaId);
        if (!blob) continue;

        const isStill = isImageBlob(blob);
        const fallbackExt = isStill
          ? 'jpg'
          : track.kind === 'video'
            ? 'mp4'
            : track.kind === 'audio'
              ? 'mp3'
              : 'png';
        const ext = inferExtension(blob, fallbackExt);
        const vfsPath = `${jobId}_media_${fileIndex}.${ext}`;
        fileIndex += 1;

        const bytes = new Uint8Array(await blob.arrayBuffer());
        await ffmpeg.writeFile(vfsPath, bytes);
        writtenFiles.push(vfsPath);
        mediaPathMap.set(track.mediaId, vfsPath);
        mediaBlobKindMap.set(
          track.mediaId,
          isStill ? 'image' : track.kind === 'audio' ? 'audio' : 'video'
        );

        if (track.kind === 'video' && !isStill) {
          const probe = await probeVirtualFile(ffmpeg, vfsPath);
          mediaProbeMap.set(track.mediaId, probe);
        }
      }

      let captionFontPath: string | null = null;
      if (spec.captions && spec.captions.length > 0 && options?.fontBlob) {
        captionFontPath = `${jobId}_caption_font.ttf`;
        const fontBytes = new Uint8Array(await options.fontBlob.arrayBuffer());
        await ffmpeg.writeFile(captionFontPath, fontBytes);
        writtenFiles.push(captionFontPath);
      } else if (spec.captions && spec.captions.length > 0) {
        options?.onWarning?.(
          'Captions were skipped because no caption font file is bundled for FFmpeg.'
        );
      }

      onProgress({ percent: 10, stage: 'Building render pipeline...' });

      // B) Build FFmpeg command
      const inputArgs: string[] = [];
      const filterParts: string[] = [];
      let nextInputIdx = 0;

      // VideoTrack inputs & segments
      const concatInputLabels: string[] = [];
      let videoTimelineAccum = 0;

      if (videoTracks.length > 0) {
        for (let i = 0; i < videoTracks.length; i++) {
          const track = videoTracks[i];
          if (maxDuration !== undefined && videoTimelineAccum >= maxDuration) {
            break;
          }

          const path = mediaPathMap.get(track.mediaId);
          if (!path) continue;

          const isStillInput = mediaBlobKindMap.get(track.mediaId) === 'image';
          const probe = mediaProbeMap.get(track.mediaId);
          const speed = isStillInput ? 1 : (track.speed ?? 1);
          const volume = isStillInput ? 0 : (track.volume ?? 1);
          const rawClipDur = Math.max(0.05, track.outPoint - track.inPoint);
          const remainingBudget =
            maxDuration !== undefined
              ? Math.max(0.05, (maxDuration - videoTimelineAccum) * speed)
              : rawClipDur;
          const trimDuration = Math.min(rawClipDur, remainingBudget);
          const effectiveDur = trimDuration / speed;
          videoTimelineAccum += effectiveDur;

          const inputIdx = nextInputIdx;
          nextInputIdx += 1;
          if (isStillInput) {
            inputArgs.push(
              '-loop',
              '1',
              '-framerate',
              String(fps),
              '-t',
              trimDuration.toFixed(3),
              '-i',
              path
            );
          } else {
            inputArgs.push(
              '-ss',
              track.inPoint.toFixed(3),
              '-t',
              trimDuration.toFixed(3),
              '-i',
              path
            );
          }

          const fitMode = track.fit ?? 'cover';
          const trackGrade = getColorGradeFilter(track.colorGrade);

          if (fitMode === 'blur') {
            const preFilters =
              Math.abs(speed - 1) > 0.001
                ? `setpts=PTS/${speed.toFixed(4)},`
                : '';
            filterParts.push(
              `[${inputIdx}:v]${preFilters}split=2[vbg_src${i}][vfg_src${i}]`
            );
            filterParts.push(
              `[vbg_src${i}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:5[vbg${i}]`
            );
            filterParts.push(
              `[vfg_src${i}]scale=${width}:${height}:force_original_aspect_ratio=decrease[vfg${i}]`
            );
            const postFilters = [
              'setsar=1',
              `fps=${fps}`,
              'format=yuv420p',
              ...(trackGrade ? [trackGrade] : []),
            ];
            filterParts.push(
              `[vbg${i}][vfg${i}]overlay=(W-w)/2:(H-h)/2,${postFilters.join(',')}[vseg${i}]`
            );
          } else {
            const vFilters: string[] = [];
            if (Math.abs(speed - 1) > 0.001) {
              vFilters.push(`setpts=PTS/${speed.toFixed(4)}`);
            }
            if (fitMode === 'contain') {
              vFilters.push(
                `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
                `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
              );
            } else {
              vFilters.push(
                `scale=${width}:${height}:force_original_aspect_ratio=increase`,
                `crop=${width}:${height}`
              );
            }
            vFilters.push('setsar=1', `fps=${fps}`, 'format=yuv420p');
            if (trackGrade) {
              vFilters.push(trackGrade);
            }
            filterParts.push(`[${inputIdx}:v]${vFilters.join(',')}[vseg${i}]`);
          }

          const hasAudio = !isStillInput && (probe?.hasAudio ?? false);
          if (hasAudio && volume > 0) {
            const aFilters: string[] = [
              'aresample=44100',
              'aformat=sample_fmts=fltp:channel_layouts=stereo',
            ];
            if (Math.abs(speed - 1) > 0.001) {
              aFilters.push(`atempo=${speed.toFixed(4)}`);
            }
            if (Math.abs(volume - 1) > 0.001) {
              aFilters.push(`volume=${volume.toFixed(3)}`);
            }
            aFilters.push('asetpts=PTS-STARTPTS');
            filterParts.push(`[${inputIdx}:a]${aFilters.join(',')}[aseg${i}]`);
          } else {
            filterParts.push(
              `anullsrc=r=44100:cl=stereo,atrim=0:${effectiveDur.toFixed(3)},asetpts=PTS-STARTPTS[aseg${i}]`
            );
          }

          concatInputLabels.push(`[vseg${i}][aseg${i}]`);
        }
      }

      const segmentCount = concatInputLabels.length;
      if (segmentCount > 0) {
        filterParts.push(
          `${concatInputLabels.join('')}concat=n=${segmentCount}:v=1:a=1[vcat][acat]`
        );
      } else {
        filterParts.push(
          `color=c=black:s=${width}x${height}:r=${fps}:d=${targetTotalSeconds.toFixed(3)},format=yuv420p[vcat]`
        );
        filterParts.push(
          `anullsrc=r=44100:cl=stereo,atrim=0:${targetTotalSeconds.toFixed(3)},asetpts=PTS-STARTPTS[acat]`
        );
      }

      let currentVideoLabel = 'vcat';

      // Global colorGrade
      const globalGradeFilter = getColorGradeFilter(spec.colorGrade);
      if (globalGradeFilter) {
        filterParts.push(`[${currentVideoLabel}]${globalGradeFilter}[vgraded]`);
        currentVideoLabel = 'vgraded';
      }

      // OverlayTracks
      const margin = Math.max(8, Math.round(width * 0.04));
      for (let i = 0; i < overlayTracks.length; i++) {
        const ov = overlayTracks[i];
        if (maxDuration !== undefined && ov.startAt >= maxDuration) {
          continue;
        }
        const path = mediaPathMap.get(ov.mediaId);
        if (!path) continue;

        const inputIdx = nextInputIdx;
        nextInputIdx += 1;
        inputArgs.push('-i', path);

        const targetW = makeEven(width * ov.scale);
        const ovFilters: string[] = [`scale=${targetW}:-2`, 'format=rgba'];

        if (ov.border && ov.border.width > 0) {
          const bw = Math.round(ov.border.width);
          ovFilters.push(
            `pad=iw+${bw * 2}:ih+${bw * 2}:${bw}:${bw}:color=${ov.border.color}`
          );
        }

        if (ov.opacity < 1) {
          ovFilters.push(`colorchannelmixer=aa=${ov.opacity.toFixed(3)}`);
        }

        const xExpr = computeOverlayX(ov.x, margin);
        const yExpr = computeOverlayY(ov.y, margin);
        const endAt =
          maxDuration !== undefined
            ? Math.min(ov.startAt + ov.duration, maxDuration)
            : ov.startAt + ov.duration;
        const enableExpr = `between(t,${ov.startAt.toFixed(3)},${endAt.toFixed(3)})`;

        if (ov.shadow) {
          filterParts.push(
            `[${inputIdx}:v]${ovFilters.join(',')},split[ovmain_src${i}][ovsh_src${i}]`
          );
          filterParts.push(
            `[ovsh_src${i}]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.45[ovsh${i}]`
          );
          filterParts.push(
            `[${currentVideoLabel}][ovsh${i}]overlay=(${xExpr})+6:(${yExpr})+6:enable='${enableExpr}'[vsh${i}]`
          );
          filterParts.push(
            `[vsh${i}][ovmain_src${i}]overlay=${xExpr}:${yExpr}:enable='${enableExpr}'[vov${i}]`
          );
        } else {
          filterParts.push(`[${inputIdx}:v]${ovFilters.join(',')}[ov${i}]`);
          filterParts.push(
            `[${currentVideoLabel}][ov${i}]overlay=${xExpr}:${yExpr}:enable='${enableExpr}'[vov${i}]`
          );
        }
        currentVideoLabel = `vov${i}`;
      }

      // AudioTracks
      const audioMixLabels: string[] = ['[acat]'];
      for (let i = 0; i < audioTracks.length; i++) {
        const aud = audioTracks[i];
        if (maxDuration !== undefined && aud.startAt >= maxDuration) {
          continue;
        }
        const path = mediaPathMap.get(aud.mediaId);
        if (!path) continue;

        const inputIdx = nextInputIdx;
        nextInputIdx += 1;

        const availableTimeline = Math.max(0.05, targetTotalSeconds - aud.startAt);
        const rawClipDur =
          aud.outPoint !== undefined
            ? Math.min(Math.max(0.05, aud.outPoint - aud.inPoint), availableTimeline)
            : availableTimeline;

        if (aud.loop) {
          inputArgs.push('-stream_loop', '-1');
        }
        inputArgs.push(
          '-ss',
          aud.inPoint.toFixed(3),
          '-t',
          rawClipDur.toFixed(3),
          '-i',
          path
        );

        const aFilters: string[] = [
          'aresample=44100',
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          `volume=${aud.volume.toFixed(3)}`,
        ];

        if (aud.fadeIn && aud.fadeIn > 0) {
          const fadeInDur = Math.min(aud.fadeIn, rawClipDur);
          aFilters.push(`afade=t=in:st=0:d=${fadeInDur.toFixed(3)}`);
        }
        if (aud.fadeOut && aud.fadeOut > 0) {
          const fadeOutDur = Math.min(aud.fadeOut, rawClipDur);
          const fadeOutStart = Math.max(0, rawClipDur - fadeOutDur);
          aFilters.push(
            `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`
          );
        }
        if (aud.startAt > 0) {
          const delayMs = Math.round(aud.startAt * 1000);
          aFilters.push(`adelay=${delayMs}|${delayMs}`);
        }

        filterParts.push(`[${inputIdx}:a]${aFilters.join(',')}[aud${i}]`);
        audioMixLabels.push(`[aud${i}]`);
      }

      let finalAudioLabel = 'acat';
      if (audioMixLabels.length > 1) {
        filterParts.push(
          `${audioMixLabels.join('')}amix=inputs=${audioMixLabels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`
        );
        finalAudioLabel = 'aout';
      }

      // Captions (only when a font file is provided in VFS)
      if (captionFontPath && spec.captions && spec.captions.length > 0) {
        const fontSize = Math.max(28, Math.round(height * 0.036));
        for (let i = 0; i < spec.captions.length; i++) {
          const cap = spec.captions[i];
          if (maxDuration !== undefined && cap.start >= maxDuration) continue;
          const endSec =
            maxDuration !== undefined ? Math.min(cap.end, maxDuration) : cap.end;
          if (endSec <= cap.start) continue;
          const yExpr =
            cap.position === 'center' ? '(h-text_h)/2' : 'h-text_h-80';
          const escapedText = escapeDrawtext(cap.text);
          const enableExpr = `between(t,${cap.start.toFixed(3)},${endSec.toFixed(3)})`;
          filterParts.push(
            `[${currentVideoLabel}]drawtext=fontfile=${captionFontPath}:text='${escapedText}':fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=${yExpr}:enable='${enableExpr}'[vcap${i}]`
          );
          currentVideoLabel = `vcap${i}`;
        }
      }

      // Ensure final video format is yuv420p
      filterParts.push(`[${currentVideoLabel}]format=yuv420p[vout]`);

      if (options?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const filterComplex = filterParts.join(';');
      const args: string[] = [
        ...inputArgs,
        '-filter_complex',
        filterComplex,
        '-map',
        '[vout]',
        '-map',
        `[${finalAudioLabel}]`,
        '-t',
        targetTotalSeconds.toFixed(3),
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath,
      ];

      writtenFiles.push(outputPath);

      const errorTail: string[] = [];
      let lastPercent = 10;
      const logHandler = ({ message }: { type: string; message: string }): void => {
        errorTail.push(message);
        if (errorTail.length > 35) {
          errorTail.shift();
        }
        const elapsed = parseTimeSeconds(message);
        if (elapsed !== null && targetTotalSeconds > 0) {
          const computed = Math.min(
            98,
            Math.max(10, Math.round((elapsed / targetTotalSeconds) * 85) + 10)
          );
          if (computed > lastPercent) {
            lastPercent = computed;
            onProgress({ percent: computed, stage: 'Encoding video...' });
          }
        }
      };

      ffmpeg.on('log', logHandler);
      let exitCode = 1;
      try {
        exitCode = await ffmpeg.exec(args);
      } finally {
        ffmpeg.off('log', logHandler);
      }

      if (options?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (exitCode !== 0) {
        const tail = errorTail.slice(-10).join('\n');
        throw new Error(`FFmpeg render failed (exit code ${exitCode}).\n${tail}`);
      }

      onProgress({ percent: 99, stage: 'Reading output...' });
      const outputData = await ffmpeg.readFile(outputPath);
      const safeBytes = toSafeUint8Array(outputData);
      if (safeBytes.byteLength === 0) {
        throw new Error('FFmpeg produced an empty output file.');
      }

      onProgress({ percent: 100, stage: 'Complete' });
      return new Blob([safeBytes], { type: 'video/mp4' });
    } finally {
      for (const path of writtenFiles) {
        await ffmpeg.deleteFile(path).catch(() => undefined);
      }
    }
  });
}

export async function extractFrames(
  mediaBlob: Blob,
  timestamps: number[]
): Promise<Blob[]> {
  if (timestamps.length === 0) {
    return [];
  }
  if (mediaBlob.size > MAX_INPUT_VIDEO_BYTES) {
    throw new Error('Input video exceeds maximum 300 MB size limit.');
  }

  return withFFmpegLock(async (ffmpeg) => {
    const jobId = nextJobId();
    const ext = inferExtension(mediaBlob, 'mp4');
    const inputPath = `${jobId}_frames_in.${ext}`;
    const filesToDelete: string[] = [inputPath];

    const bytes = new Uint8Array(await mediaBlob.arrayBuffer());
    await ffmpeg.writeFile(inputPath, bytes);

    const frameBlobs: Blob[] = [];
    const errorTail: string[] = [];
    const logHandler = ({ message }: { type: string; message: string }): void => {
      errorTail.push(message);
      if (errorTail.length > 25) errorTail.shift();
    };
    ffmpeg.on('log', logHandler);

    try {
      for (let i = 0; i < timestamps.length; i++) {
        const ts = Math.max(0, timestamps[i]);
        const outFrame = `${jobId}_frame_${i}.jpg`;
        filesToDelete.push(outFrame);

        const exitCode = await ffmpeg.exec([
          '-ss',
          ts.toFixed(3),
          '-i',
          inputPath,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          outFrame,
        ]);

        if (exitCode !== 0) {
          throw new Error(
            `Failed to extract frame at ${ts.toFixed(2)}s (exit code ${exitCode}).\n${errorTail.slice(-6).join('\n')}`
          );
        }

        const data = await ffmpeg.readFile(outFrame);
        const safeBytes = toSafeUint8Array(data);
        if (safeBytes.byteLength === 0) {
          throw new Error(`Extracted empty frame at ${ts.toFixed(2)}s.`);
        }
        frameBlobs.push(new Blob([safeBytes], { type: 'image/jpeg' }));
      }
      return frameBlobs;
    } finally {
      ffmpeg.off('log', logHandler);
      for (const path of filesToDelete) {
        await ffmpeg.deleteFile(path).catch(() => undefined);
      }
    }
  });
}
