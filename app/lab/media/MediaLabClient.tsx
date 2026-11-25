'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  Film,
  Layers,
  Loader2,
  Palette,
  Play,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { AiDirectorTab } from './AiDirectorTab';
import {
  COLOR_GRADE_CURVES,
  extractFrames,
  probeMedia,
  renderEditSpec,
  type MediaProbeResult,
  type RenderProgress,
} from '@/lib/media/compositor';
import {
  COLOR_GRADES,
  normalizeEditSpec,
  type ColorGradePreset,
  type EditFormat,
  type EditSpec,
  type OverlayX,
  type OverlayY,
  type VideoTrack,
} from '@/lib/media/edit-types';
import {
  FFMPEG_CORE_BASE_URL,
  getLoadError,
  getLoadState,
  loadFFmpeg,
  onProgress,
  type FFmpegLoadProgress,
  type FFmpegLoadState,
} from '@/lib/media/ffmpeg-loader';
import { formatBytes } from '@/lib/media/process';
import { useMediaPreview } from '@/lib/media/useMediaPreview';

type LabMediaKind = 'video' | 'image' | 'audio';
type LabTab = 'tools' | 'ai-director';

interface UploadedMediaItem {
  id: string;
  kind: LabMediaKind;
  file: File;
  name: string;
  size: number;
  probe: MediaProbeResult;
}

interface RenderArtifact {
  url: string;
  size: number;
  renderMs: number;
  filename: string;
}

type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const MAX_UPLOAD_FILES = 6;
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_UPLOAD_BYTES = 20 * 1024 * 1024;

const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a']);

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function classifyLabFile(file: File): {
  kind: LabMediaKind;
  maxBytes: number;
} {
  const ext = getExt(file.name);
  const mime = file.type.toLowerCase();

  if (
    VIDEO_EXTS.has(ext) ||
    mime === 'video/mp4' ||
    mime === 'video/quicktime' ||
    mime === 'video/webm'
  ) {
    return { kind: 'video', maxBytes: MAX_VIDEO_UPLOAD_BYTES };
  }
  if (
    IMAGE_EXTS.has(ext) ||
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp'
  ) {
    return { kind: 'image', maxBytes: MAX_IMAGE_UPLOAD_BYTES };
  }
  if (
    AUDIO_EXTS.has(ext) ||
    mime === 'audio/mpeg' ||
    mime === 'audio/mp3' ||
    mime === 'audio/wav' ||
    mime === 'audio/x-wav' ||
    mime === 'audio/mp4' ||
    mime === 'audio/x-m4a'
  ) {
    return { kind: 'audio', maxBytes: MAX_AUDIO_UPLOAD_BYTES };
  }

  throw new Error(
    `Unsupported file "${file.name}". Allowed: Video (MP4/MOV/WebM), Image (JPG/PNG/WebP), Audio (MP3/WAV/M4A).`
  );
}

function inferFormatFromDimensions(
  width: number | null,
  height: number | null
): EditFormat {
  if (!width || !height) return '16:9';
  const ratio = width / height;
  if (ratio < 0.85) return '9:16';
  if (ratio > 1.15) return '16:9';
  return '1:1';
}

function buildDefaultSpec(mediaId: string, duration: number, format: EditFormat): EditSpec {
  const safeOut = Math.min(Math.max(1, Number(duration.toFixed(2)) || 5), 10);
  return {
    v: 2,
    format,
    fps: 30,
    totalSeconds: safeOut,
    colorGrade: 'none',
    tracks: [
      {
        kind: 'video',
        mediaId,
        startAt: 0,
        inPoint: 0,
        outPoint: safeOut,
        volume: 1,
        speed: 1,
      },
    ],
  };
}

function cornerToXY(corner: OverlayCorner): { x: OverlayX; y: OverlayY } {
  switch (corner) {
    case 'top-left':
      return { x: 'left', y: 'top' };
    case 'top-right':
      return { x: 'right', y: 'top' };
    case 'bottom-left':
      return { x: 'left', y: 'bottom' };
    case 'bottom-right':
      return { x: 'right', y: 'bottom' };
  }
}

const subscribeNoop = () => () => {};

function getEnvSnapshot(): string {
  if (typeof window === 'undefined') return 'ssr';
  const hasSab = typeof SharedArrayBuffer !== 'undefined';
  const isolated = Boolean(window.crossOriginIsolated);
  return `${hasSab ? '1' : '0'}:${isolated ? '1' : '0'}`;
}

export function MediaLabClient() {
  const envSnapshot = useSyncExternalStore(
    subscribeNoop,
    getEnvSnapshot,
    () => 'ssr'
  );

  const isClient = envSnapshot !== 'ssr';
  const hasSharedArrayBuffer = envSnapshot.startsWith('1:');
  const isCrossOriginIsolated = envSnapshot.endsWith(':1');
  const [activeTab, setActiveTab] = useState<LabTab>('tools');

  // Section A: FFmpeg Loader State
  const [loadState, setLoadState] = useState<FFmpegLoadState>(() =>
    getLoadState()
  );
  const [loadProgress, setLoadProgress] = useState<FFmpegLoadProgress | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(() => {
    const err = getLoadError();
    return err ? err.message : null;
  });

  // Section B: Uploaded files
  const [mediaItems, setMediaItems] = useState<UploadedMediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Section C: Trim Test
  const [trimVideoId, setTrimVideoId] = useState<string>('');
  const [trimIn, setTrimIn] = useState<string>('0');
  const [trimOut, setTrimOut] = useState<string>('3');
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimProgress, setTrimProgress] = useState<RenderProgress | null>(null);
  const [trimError, setTrimError] = useState<string | null>(null);
  const [trimArtifact, setTrimArtifact] = useState<RenderArtifact | null>(null);

  // Section D: Concat Test
  const [concatSelectedIds, setConcatSelectedIds] = useState<string[]>([]);
  const [concatBusy, setConcatBusy] = useState(false);
  const [concatProgress, setConcatProgress] = useState<RenderProgress | null>(
    null
  );
  const [concatError, setConcatError] = useState<string | null>(null);
  const [concatArtifact, setConcatArtifact] = useState<RenderArtifact | null>(
    null
  );

  // Section E: Overlay Test
  const [overlayVideoId, setOverlayVideoId] = useState<string>('');
  const [overlayImageId, setOverlayImageId] = useState<string>('');
  const [overlayCorner, setOverlayCorner] =
    useState<OverlayCorner>('top-right');
  const [overlayScale, setOverlayScale] = useState<number>(0.25);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [overlayProgress, setOverlayProgress] = useState<RenderProgress | null>(
    null
  );
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [overlayArtifact, setOverlayArtifact] =
    useState<RenderArtifact | null>(null);

  // Section F: Color Grade Test
  const [gradeVideoId, setGradeVideoId] = useState<string>('');
  const [gradePreset, setGradePreset] = useState<ColorGradePreset>('warm');
  const [gradeBusy, setGradeBusy] = useState(false);
  const [gradeProgress, setGradeProgress] = useState<RenderProgress | null>(
    null
  );
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [gradeArtifact, setGradeArtifact] = useState<RenderArtifact | null>(
    null
  );
  const [beforeStillUrl, setBeforeStillUrl] = useState<string | null>(null);
  const [afterStillUrl, setAfterStillUrl] = useState<string | null>(null);
  const [stillTimestamp, setStillTimestamp] = useState<number>(2);

  // Section G: Edit Spec Test
  const [specJson, setSpecJson] = useState<string>(() =>
    JSON.stringify(buildDefaultSpec('media-1', 5, '16:9'), null, 2)
  );
  const [specBusy, setSpecBusy] = useState(false);
  const [specProgress, setSpecProgress] = useState<RenderProgress | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [specWarnings, setSpecWarnings] = useState<string[]>([]);
  const [specArtifact, setSpecArtifact] = useState<RenderArtifact | null>(null);
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(false);

  // Keep track of created object URLs for cleanup
  const activeUrlsRef = useRef<Set<string>>(new Set());

  const registerUrl = useCallback((url: string) => {
    activeUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeUrl = useCallback((url: string | null | undefined) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    activeUrlsRef.current.delete(url);
  }, []);

  useEffect(() => {
    const urls = activeUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  // Derived lists
  const videos = useMemo(
    () => mediaItems.filter((item) => item.kind === 'video'),
    [mediaItems]
  );
  const images = useMemo(
    () => mediaItems.filter((item) => item.kind === 'image'),
    [mediaItems]
  );

  const mediaBlobsMap = useMemo(() => {
    const map = new Map<string, Blob>();
    for (const item of mediaItems) {
      map.set(item.id, item.file);
    }
    return map;
  }, [mediaItems]);

  const parsedLiveSpec = useMemo<EditSpec | null>(() => {
    if (!livePreviewEnabled) return null;
    const norm = normalizeEditSpec(specJson);
    if (!norm.ok) return null;
    for (const track of norm.spec.tracks) {
      if ('mediaId' in track && !mediaBlobsMap.has(track.mediaId)) {
        return null;
      }
    }
    return norm.spec;
  }, [livePreviewEnabled, specJson, mediaBlobsMap]);

  const livePreview = useMediaPreview(parsedLiveSpec, mediaBlobsMap);

  const handleLoadFFmpeg = useCallback(async () => {
    setLoadError(null);
    setLoadState('loading');
    const unsubscribe = onProgress((prog) => {
      setLoadProgress(prog);
    });
    try {
      await loadFFmpeg();
      setLoadState(getLoadState());
    } catch (err) {
      setLoadState(getLoadState());
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      unsubscribe();
    }
  }, []);

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      setUploadError(null);

      if (incoming.length > MAX_UPLOAD_FILES) {
        setUploadError(
          `You selected ${incoming.length} files. Maximum ${MAX_UPLOAD_FILES} files can be uploaded at once.`
        );
        return;
      }

      if (mediaItems.length + incoming.length > MAX_UPLOAD_FILES) {
        setUploadError(
          `Workspace already has ${mediaItems.length} file(s). Maximum ${MAX_UPLOAD_FILES} total files allowed; remove some first.`
        );
        return;
      }

      setUploading(true);
      try {
        if (getLoadState() !== 'ready') {
          await handleLoadFFmpeg();
        }

        const added: UploadedMediaItem[] = [];
        for (const file of incoming) {
          const { kind, maxBytes } = classifyLabFile(file);
          if (file.size > maxBytes) {
            throw new Error(
              `"${file.name}" (${formatBytes(file.size)}) exceeds the ${formatBytes(maxBytes)} limit for ${kind} files.`
            );
          }

          const probe = await probeMedia(file);
          fileCounterRef.current += 1;
          const id = `media-${fileCounterRef.current}`;

          added.push({
            id,
            kind,
            file,
            name: file.name,
            size: file.size,
            probe,
          });
        }

        setMediaItems((prev) => [...prev, ...added]);

        const firstAddedVideo = added.find((a) => a.kind === 'video');
        const firstAddedImage = added.find((a) => a.kind === 'image');

        if (firstAddedVideo) {
          if (!trimVideoId) {
            setTrimVideoId(firstAddedVideo.id);
            setTrimIn('0');
            setTrimOut(
              String(
                Math.min(
                  Math.max(1, Number(firstAddedVideo.probe.duration.toFixed(2)) || 3),
                  5
                )
              )
            );
          }
          if (!overlayVideoId) {
            setOverlayVideoId(firstAddedVideo.id);
          }
          if (!gradeVideoId) {
            setGradeVideoId(firstAddedVideo.id);
          }
          if (videos.length === 0) {
            const fmt = inferFormatFromDimensions(
              firstAddedVideo.probe.width,
              firstAddedVideo.probe.height
            );
            setSpecJson(
              JSON.stringify(
                buildDefaultSpec(
                  firstAddedVideo.id,
                  firstAddedVideo.probe.duration || 5,
                  fmt
                ),
                null,
                2
              )
            );
          }
        }
        if (firstAddedImage && !overlayImageId) {
          setOverlayImageId(firstAddedImage.id);
        }
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [
      gradeVideoId,
      handleLoadFFmpeg,
      mediaItems.length,
      overlayImageId,
      overlayVideoId,
      trimVideoId,
      videos.length,
    ]
  );

  const handleRemoveMedia = useCallback(
    (id: string) => {
      setMediaItems((prev) => prev.filter((item) => item.id !== id));
      setConcatSelectedIds((prev) => prev.filter((item) => item !== id));
      if (trimVideoId === id) setTrimVideoId('');
      if (overlayVideoId === id) setOverlayVideoId('');
      if (overlayImageId === id) setOverlayImageId('');
      if (gradeVideoId === id) setGradeVideoId('');
    },
    [gradeVideoId, overlayImageId, overlayVideoId, trimVideoId]
  );

  const selectedTrimVideo = useMemo(
    () => videos.find((v) => v.id === trimVideoId) ?? null,
    [videos, trimVideoId]
  );

  // Section C: Trim
  const handleRunTrim = useCallback(async () => {
    setTrimError(null);
    if (!selectedTrimVideo) {
      setTrimError('Select an uploaded video first.');
      return;
    }

    const inSec = Number(trimIn);
    const outSec = Number(trimOut);
    const maxDur = selectedTrimVideo.probe.duration;

    if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) {
      setTrimError('In and out points must be valid numbers.');
      return;
    }
    if (inSec < 0) {
      setTrimError('In point must be >= 0 seconds.');
      return;
    }
    if (outSec <= inSec) {
      setTrimError('Out point must be strictly greater than in point.');
      return;
    }
    if (maxDur > 0 && outSec > maxDur + 0.05) {
      setTrimError(
        `Out point (${outSec}s) exceeds video duration (${maxDur.toFixed(2)}s).`
      );
      return;
    }

    const clampedOut = maxDur > 0 ? Math.min(outSec, maxDur) : outSec;
    const duration = Math.max(0.1, clampedOut - inSec);
    const format = inferFormatFromDimensions(
      selectedTrimVideo.probe.width,
      selectedTrimVideo.probe.height
    );

    const spec: EditSpec = {
      v: 2,
      format,
      fps: 30,
      totalSeconds: duration,
      colorGrade: 'none',
      tracks: [
        {
          kind: 'video',
          mediaId: selectedTrimVideo.id,
          startAt: 0,
          inPoint: inSec,
          outPoint: clampedOut,
          volume: 1,
          speed: 1,
        },
      ],
    };

    setTrimBusy(true);
    setTrimProgress({ percent: 0, stage: 'Starting trim...' });
    const started = performance.now();

    try {
      const blob = await renderEditSpec(spec, mediaBlobsMap, setTrimProgress);
      const renderMs = Math.round(performance.now() - started);
      const url = registerUrl(URL.createObjectURL(blob));
      setTrimArtifact((prev) => {
        if (prev) revokeUrl(prev.url);
        return { url, size: blob.size, renderMs, filename: 'trimmed.mp4' };
      });
    } catch (err) {
      setTrimError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrimBusy(false);
    }
  }, [
    mediaBlobsMap,
    registerUrl,
    revokeUrl,
    selectedTrimVideo,
    trimIn,
    trimOut,
  ]);

  // Section D: Concat
  const toggleConcatVideo = useCallback((id: string) => {
    setConcatSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((v) => v !== id);
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), id];
      }
      return [...prev, id];
    });
  }, []);

  const handleRunConcat = useCallback(async () => {
    setConcatError(null);
    if (concatSelectedIds.length < 2 || concatSelectedIds.length > 3) {
      setConcatError('Select 2 or 3 uploaded videos to concatenate.');
      return;
    }

    const chosen = concatSelectedIds
      .map((id) => videos.find((v) => v.id === id))
      .filter((v): v is UploadedMediaItem => Boolean(v));

    if (chosen.length < 2) {
      setConcatError('Selected videos are no longer available.');
      return;
    }

    let cursor = 0;
    const tracks: VideoTrack[] = chosen.map((vid) => {
      const dur = Math.max(0.5, vid.probe.duration || 3);
      const track: VideoTrack = {
        kind: 'video',
        mediaId: vid.id,
        startAt: cursor,
        inPoint: 0,
        outPoint: dur,
        volume: 1,
        speed: 1,
      };
      cursor += dur;
      return track;
    });

    const format = inferFormatFromDimensions(
      chosen[0].probe.width,
      chosen[0].probe.height
    );

    const spec: EditSpec = {
      v: 2,
      format,
      fps: 30,
      totalSeconds: Math.min(300, cursor),
      colorGrade: 'none',
      tracks,
    };

    setConcatBusy(true);
    setConcatProgress({ percent: 0, stage: 'Starting concat...' });
    const started = performance.now();

    try {
      const blob = await renderEditSpec(spec, mediaBlobsMap, setConcatProgress);
      const renderMs = Math.round(performance.now() - started);
      const url = registerUrl(URL.createObjectURL(blob));
      setConcatArtifact((prev) => {
        if (prev) revokeUrl(prev.url);
        return { url, size: blob.size, renderMs, filename: 'concat.mp4' };
      });
    } catch (err) {
      setConcatError(err instanceof Error ? err.message : String(err));
    } finally {
      setConcatBusy(false);
    }
  }, [concatSelectedIds, mediaBlobsMap, registerUrl, revokeUrl, videos]);

  // Section E: Overlay
  const handleRunOverlay = useCallback(async () => {
    setOverlayError(null);
    const vid = videos.find((v) => v.id === overlayVideoId);
    const img = images.find((im) => im.id === overlayImageId);

    if (!vid) {
      setOverlayError('Select an uploaded video.');
      return;
    }
    if (!img) {
      setOverlayError('Select an uploaded image.');
      return;
    }

    const dur = Math.max(0.5, vid.probe.duration || 5);
    const { x, y } = cornerToXY(overlayCorner);
    const format = inferFormatFromDimensions(vid.probe.width, vid.probe.height);

    const spec: EditSpec = {
      v: 2,
      format,
      fps: 30,
      totalSeconds: dur,
      colorGrade: 'none',
      tracks: [
        {
          kind: 'video',
          mediaId: vid.id,
          startAt: 0,
          inPoint: 0,
          outPoint: dur,
          volume: 1,
          speed: 1,
        },
        {
          kind: 'overlay',
          mediaId: img.id,
          startAt: 0,
          duration: dur,
          x,
          y,
          scale: overlayScale,
          opacity: 1,
          shadow: true,
        },
      ],
    };

    setOverlayBusy(true);
    setOverlayProgress({ percent: 0, stage: 'Starting overlay...' });
    const started = performance.now();

    try {
      const blob = await renderEditSpec(spec, mediaBlobsMap, setOverlayProgress);
      const renderMs = Math.round(performance.now() - started);
      const url = registerUrl(URL.createObjectURL(blob));
      setOverlayArtifact((prev) => {
        if (prev) revokeUrl(prev.url);
        return { url, size: blob.size, renderMs, filename: 'overlay.mp4' };
      });
    } catch (err) {
      setOverlayError(err instanceof Error ? err.message : String(err));
    } finally {
      setOverlayBusy(false);
    }
  }, [
    images,
    mediaBlobsMap,
    overlayCorner,
    overlayImageId,
    overlayScale,
    overlayVideoId,
    registerUrl,
    revokeUrl,
    videos,
  ]);

  // Section F: Color Grade + Before/After Stills
  const handleRunGrade = useCallback(async () => {
    setGradeError(null);
    const vid = videos.find((v) => v.id === gradeVideoId);
    if (!vid) {
      setGradeError('Select an uploaded video.');
      return;
    }

    const dur = Math.max(0.5, vid.probe.duration || 4);
    const sampleTs = dur >= 2.05 ? 2 : Number((dur / 2).toFixed(2));
    setStillTimestamp(sampleTs);

    const format = inferFormatFromDimensions(vid.probe.width, vid.probe.height);
    const spec: EditSpec = {
      v: 2,
      format,
      fps: 30,
      totalSeconds: dur,
      colorGrade: gradePreset,
      tracks: [
        {
          kind: 'video',
          mediaId: vid.id,
          startAt: 0,
          inPoint: 0,
          outPoint: dur,
          volume: 1,
          speed: 1,
        },
      ],
    };

    setGradeBusy(true);
    setGradeProgress({ percent: 0, stage: 'Starting color grade...' });
    const started = performance.now();

    try {
      const gradedBlob = await renderEditSpec(
        spec,
        mediaBlobsMap,
        setGradeProgress
      );
      const renderMs = Math.round(performance.now() - started);

      setGradeProgress({ percent: 99, stage: 'Extracting comparison frames...' });
      const [beforeFrames, afterFrames] = await Promise.all([
        extractFrames(vid.file, [sampleTs]),
        extractFrames(gradedBlob, [sampleTs]),
      ]);

      const videoUrl = registerUrl(URL.createObjectURL(gradedBlob));
      setGradeArtifact((prev) => {
        if (prev) revokeUrl(prev.url);
        return {
          url: videoUrl,
          size: gradedBlob.size,
          renderMs,
          filename: `graded-${gradePreset}.mp4`,
        };
      });

      if (beforeFrames[0]) {
        const bUrl = registerUrl(URL.createObjectURL(beforeFrames[0]));
        setBeforeStillUrl((prev) => {
          revokeUrl(prev);
          return bUrl;
        });
      }
      if (afterFrames[0]) {
        const aUrl = registerUrl(URL.createObjectURL(afterFrames[0]));
        setAfterStillUrl((prev) => {
          revokeUrl(prev);
          return aUrl;
        });
      }
      setGradeProgress({ percent: 100, stage: 'Complete' });
    } catch (err) {
      setGradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setGradeBusy(false);
    }
  }, [gradePreset, gradeVideoId, mediaBlobsMap, registerUrl, revokeUrl, videos]);

  // Section G: EditSpec Render
  const handlePopulateFirstVideoSpec = useCallback(() => {
    const first = videos[0];
    if (!first) return;
    const fmt = inferFormatFromDimensions(first.probe.width, first.probe.height);
    setSpecJson(
      JSON.stringify(
        buildDefaultSpec(first.id, first.probe.duration || 5, fmt),
        null,
        2
      )
    );
    setSpecError(null);
    setSpecWarnings([]);
  }, [videos]);

  const handleRunEditSpec = useCallback(async () => {
    setSpecError(null);
    setSpecWarnings([]);

    const normalized = normalizeEditSpec(specJson);
    if (!normalized.ok) {
      setSpecError(normalized.errors.join('\n'));
      return;
    }

    setSpecWarnings(normalized.warnings);
    setSpecBusy(true);
    setSpecProgress({ percent: 0, stage: 'Starting EditSpec render...' });
    const started = performance.now();

    try {
      const blob = await renderEditSpec(
        normalized.spec,
        mediaBlobsMap,
        setSpecProgress
      );
      const renderMs = Math.round(performance.now() - started);
      const url = registerUrl(URL.createObjectURL(blob));
      setSpecArtifact((prev) => {
        if (prev) revokeUrl(prev.url);
        return {
          url,
          size: blob.size,
          renderMs,
          filename: 'edit-spec-output.mp4',
        };
      });
    } catch (err) {
      setSpecError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpecBusy(false);
    }
  }, [mediaBlobsMap, registerUrl, revokeUrl, specJson]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 overflow-x-hidden">
      <header className="border-b border-slate-800/90 bg-[#0B0F17]/95 sticky top-0 z-20 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-3 py-3.5 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold tracking-tight text-slate-100 truncate">
              FFmpeg.wasm Media Lab
            </h1>
            <p className="text-xs text-slate-400 truncate">
              Client-side WebAssembly compositor, Gemini vision analyzer &amp; AI Edit Director
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <div
              role="tablist"
              aria-label="Media Lab Sections"
              className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'tools'}
                onClick={() => setActiveTab('tools')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
                  activeTab === 'tools'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Scissors className="h-3.5 w-3.5" />
                Tools
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'ai-director'}
                onClick={() => setActiveTab('ai-director')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
                  activeTab === 'ai-director'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Wand2 className="h-3.5 w-3.5" />
                AI Director
              </button>
            </div>
            <span
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium border ${
                loadState === 'ready'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : loadState === 'loading'
                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                    : loadState === 'error'
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                      : 'border-slate-700 bg-slate-800/70 text-slate-300'
              }`}
            >
              FFmpeg: {loadState}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:px-6">
        <div className={activeTab === 'ai-director' ? 'space-y-6' : 'hidden'}>
          <AiDirectorTab
            mediaItems={mediaItems}
            mediaBlobsMap={mediaBlobsMap}
            onGoToTools={() => setActiveTab('tools')}
          />
        </div>

        <div className={activeTab === 'tools' ? 'space-y-6' : 'hidden'}>
        {/* SECTION A: FFMPEG STATUS */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Cpu className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                A) FFmpeg Status &amp; Cross-Origin Isolation
              </h2>
            </div>
            <button
              type="button"
              onClick={handleLoadFFmpeg}
              disabled={loadState === 'loading' || loadState === 'ready'}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loadState === 'loading' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : loadState === 'ready' ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {loadState === 'ready'
                ? 'FFmpeg Ready'
                : loadState === 'loading'
                  ? 'Loading FFmpeg...'
                  : 'Load FFmpeg'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="text-slate-400">Load State</div>
              <div className="mt-1 font-mono text-sm font-semibold text-slate-100">
                {loadState}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="text-slate-400">SharedArrayBuffer</div>
              <div
                className={`mt-1 font-mono text-sm font-semibold ${
                  !isClient
                    ? 'text-slate-400'
                    : hasSharedArrayBuffer
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                }`}
              >
                {!isClient
                  ? 'Checking...'
                  : hasSharedArrayBuffer
                    ? 'Available'
                    : 'Undefined (Missing)'}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="text-slate-400">crossOriginIsolated</div>
              <div
                className={`mt-1 font-mono text-sm font-semibold ${
                  !isClient
                    ? 'text-slate-400'
                    : isCrossOriginIsolated
                      ? 'text-emerald-400'
                      : 'text-amber-400'
                }`}
              >
                {!isClient ? 'Checking...' : String(isCrossOriginIsolated)}
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-400 font-mono break-all">
            Core URL: {FFMPEG_CORE_BASE_URL}/
          </div>

          {loadProgress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>
                  Downloading {loadProgress.file === 'core' ? 'ffmpeg-core.js' : 'ffmpeg-core.wasm'}
                </span>
                <span className="font-mono">
                  {loadProgress.percent}% ({loadProgress.loadedMB.toFixed(2)} /{' '}
                  {loadProgress.totalMB.toFixed(2)} MB)
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-150"
                  style={{ width: `${loadProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {isClient && !hasSharedArrayBuffer && (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                SharedArrayBuffer is unavailable. Verify Cross-Origin-Opener-Policy:
                same-origin and Cross-Origin-Embedder-Policy: require-corp headers
                are active (if viewed inside a cross-origin iframe, open the app URL
                directly in a tab).
              </div>
            </div>
          )}

          {loadError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 whitespace-pre-wrap">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div>{loadError}</div>
            </div>
          )}
        </section>

        {/* SECTION B: UPLOAD TEST */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <Upload className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                B) Upload &amp; FFmpeg Probe Test
              </h2>
            </div>
            <span className="text-xs font-mono text-slate-400">
              {mediaItems.length} / {MAX_UPLOAD_FILES} files
            </span>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              void processFiles(e.dataTransfer.files);
            }}
            className={`rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
              dragActive
                ? 'border-sky-400 bg-sky-500/10'
                : 'border-slate-700 bg-slate-950/40'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,.mp3,.wav,.m4a,video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  void processFiles(e.target.files);
                }
                e.target.value = '';
              }}
            />
            <p className="text-xs sm:text-sm text-slate-300">
              Drag &amp; drop media files here, or{' '}
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="font-semibold text-sky-400 hover:text-sky-300 underline underline-offset-2 disabled:opacity-50"
              >
                choose files
              </button>
            </p>
            <p className="mt-1.5 text-xs text-slate-400">
              Video (MP4/MOV/WebM, max 100MB) · Image (JPG/PNG/WebP, max 10MB) · Audio
              (MP3/WAV/M4A, max 20MB) · Max 6 files
            </p>
            {uploading && (
              <div className="mt-3 inline-flex items-center gap-2 text-xs text-sky-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Probing media with FFmpeg...
              </div>
            )}
          </div>

          {uploadError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 whitespace-pre-wrap">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div>{uploadError}</div>
            </div>
          )}

          {mediaItems.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {mediaItems.map((item) => {
                const Icon =
                  item.kind === 'video'
                    ? FileVideo
                    : item.kind === 'image'
                      ? FileImage
                      : FileAudio;
                return (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 min-w-0"
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Icon className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
                      <div className="min-w-0 space-y-1 text-xs">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-sky-300">
                            {item.id}
                          </span>
                          <span className="font-medium text-slate-100 truncate max-w-[200px]">
                            {item.name}
                          </span>
                        </div>
                        <div className="text-slate-400 font-mono flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{formatBytes(item.size)}</span>
                          <span>
                            {item.kind === 'image'
                              ? 'still'
                              : `${item.probe.duration.toFixed(2)}s`}
                          </span>
                          {item.probe.width && item.probe.height && (
                            <span>
                              {item.probe.width}x{item.probe.height}
                            </span>
                          )}
                          {item.probe.fps && <span>{item.probe.fps}fps</span>}
                          {item.probe.videoCodec && (
                            <span>{item.probe.videoCodec}</span>
                          )}
                          {item.probe.audioCodec && (
                            <span>{item.probe.audioCodec}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveMedia(item.id)}
                      aria-label={`Remove ${item.name}`}
                      className="text-slate-400 hover:text-rose-400 p-1 shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* SECTION C: TRIM TEST */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-2.5">
              <Scissors className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                C) Trim Test
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="text-slate-400">Video</span>
                <select
                  value={trimVideoId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setTrimVideoId(id);
                    const found = videos.find((v) => v.id === id);
                    if (found) {
                      setTrimIn('0');
                      setTrimOut(
                        String(
                          Math.min(
                            Math.max(1, Number(found.probe.duration.toFixed(2)) || 3),
                            5
                          )
                        )
                      );
                    }
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                >
                  <option value="">-- Select uploaded video --</option>
                  {videos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id} · {v.name} ({v.probe.duration.toFixed(2)}s)
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">In Point (s)</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={trimIn}
                    onChange={(e) => setTrimIn(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">
                    Out Point (s)
                    {selectedTrimVideo
                      ? ` / ${selectedTrimVideo.probe.duration.toFixed(2)}s`
                      : ''}
                  </span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={trimOut}
                    onChange={(e) => setTrimOut(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 font-mono"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={handleRunTrim}
                disabled={trimBusy || !trimVideoId}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {trimBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Trim
              </button>
            </div>

            {trimBusy && trimProgress && <ProgressReadout progress={trimProgress} />}
            {trimError && <ErrorBox message={trimError} />}
            {trimArtifact && <ArtifactPreview artifact={trimArtifact} />}
          </section>

          {/* SECTION D: CONCAT TEST */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-2.5">
              <Film className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                D) Concat Test (2–3 Videos)
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              {videos.length === 0 ? (
                <p className="text-slate-400">Upload at least 2 videos in Section B.</p>
              ) : (
                <div className="space-y-1.5">
                  {videos.map((v) => {
                    const orderIdx = concatSelectedIds.indexOf(v.id);
                    const checked = orderIdx >= 0;
                    return (
                      <label
                        key={v.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 cursor-pointer ${
                          checked
                            ? 'border-sky-500/60 bg-sky-500/10'
                            : 'border-slate-800 bg-slate-950/60'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleConcatVideo(v.id)}
                            className="accent-sky-500"
                          />
                          <span className="font-mono text-sky-300 shrink-0">
                            {v.id}
                          </span>
                          <span className="truncate text-slate-200">{v.name}</span>
                        </div>
                        {checked && (
                          <span className="rounded bg-sky-600/30 px-1.5 py-0.5 font-mono text-[11px] text-sky-200 shrink-0">
                            #{orderIdx + 1}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={handleRunConcat}
                disabled={concatBusy || concatSelectedIds.length < 2}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {concatBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Concat ({concatSelectedIds.length} selected)
              </button>
            </div>

            {concatBusy && concatProgress && (
              <ProgressReadout progress={concatProgress} />
            )}
            {concatError && <ErrorBox message={concatError} />}
            {concatArtifact && <ArtifactPreview artifact={concatArtifact} />}
          </section>

          {/* SECTION E: OVERLAY TEST */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-2.5">
              <Layers className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                E) Image Overlay Test
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Base Video</span>
                  <select
                    value={overlayVideoId}
                    onChange={(e) => setOverlayVideoId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    <option value="">-- Select video --</option>
                    {videos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id} · {v.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-slate-400">Overlay Image</span>
                  <select
                    value={overlayImageId}
                    onChange={(e) => setOverlayImageId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    <option value="">-- Select image --</option>
                    {images.map((im) => (
                      <option key={im.id} value={im.id}>
                        {im.id} · {im.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Position</span>
                  <select
                    value={overlayCorner}
                    onChange={(e) =>
                      setOverlayCorner(e.target.value as OverlayCorner)
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    <option value="top-left">top-left</option>
                    <option value="top-right">top-right</option>
                    <option value="bottom-left">bottom-left</option>
                    <option value="bottom-right">bottom-right</option>
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-slate-400 font-mono">
                    Scale: {Math.round(overlayScale * 100)}%
                  </span>
                  <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    value={overlayScale}
                    onChange={(e) => setOverlayScale(Number(e.target.value))}
                    className="w-full accent-sky-500 mt-2"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={handleRunOverlay}
                disabled={overlayBusy || !overlayVideoId || !overlayImageId}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {overlayBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Overlay
              </button>
            </div>

            {overlayBusy && overlayProgress && (
              <ProgressReadout progress={overlayProgress} />
            )}
            {overlayError && <ErrorBox message={overlayError} />}
            {overlayArtifact && <ArtifactPreview artifact={overlayArtifact} />}
          </section>

          {/* SECTION F: COLOR GRADE TEST */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center gap-2.5">
              <Palette className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                F) Color Grade Test
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Video</span>
                  <select
                    value={gradeVideoId}
                    onChange={(e) => setGradeVideoId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    <option value="">-- Select video --</option>
                    {videos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id} · {v.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-slate-400">Preset</span>
                  <select
                    value={gradePreset}
                    onChange={(e) =>
                      setGradePreset(e.target.value as ColorGradePreset)
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    {COLOR_GRADES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {COLOR_GRADE_CURVES[gradePreset] && (
                <div className="rounded bg-slate-950/70 border border-slate-800 p-2 font-mono text-[11px] text-slate-400 break-all">
                  {COLOR_GRADE_CURVES[gradePreset]}
                </div>
              )}

              <button
                type="button"
                onClick={handleRunGrade}
                disabled={gradeBusy || !gradeVideoId}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {gradeBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Render Grade
              </button>
            </div>

            {gradeBusy && gradeProgress && (
              <ProgressReadout progress={gradeProgress} />
            )}
            {gradeError && <ErrorBox message={gradeError} />}

            {(beforeStillUrl || afterStillUrl) && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-slate-400">
                    Before ({stillTimestamp}s)
                  </div>
                  {beforeStillUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={beforeStillUrl}
                      alt="Original frame"
                      className="w-full rounded-lg border border-slate-800 object-contain bg-black max-h-48"
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-mono text-slate-400">
                    After ({gradePreset}, {stillTimestamp}s)
                  </div>
                  {afterStillUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={afterStillUrl}
                      alt="Graded frame"
                      className="w-full rounded-lg border border-slate-800 object-contain bg-black max-h-48"
                    />
                  )}
                </div>
              </div>
            )}

            {gradeArtifact && <ArtifactPreview artifact={gradeArtifact} />}
          </section>
        </div>

        {/* SECTION G: EDIT SPEC TEST */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Sparkles className="h-5 w-5 text-sky-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-semibold text-slate-100">
                G) EditSpec JSON Render Test
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {videos.length > 0 && (
                <button
                  type="button"
                  onClick={handlePopulateFirstVideoSpec}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                >
                  Reset to First Video ({videos[0].id})
                </button>
              )}
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={livePreviewEnabled}
                  onChange={(e) => setLivePreviewEnabled(e.target.checked)}
                  className="accent-sky-500"
                />
                Auto 640px Preview (1s debounce)
              </label>
              <button
                type="button"
                onClick={handleRunEditSpec}
                disabled={specBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs sm:text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {specBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Render
              </button>
            </div>
          </div>

          <textarea
            value={specJson}
            onChange={(e) => setSpecJson(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          />

          {specWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
              {specWarnings.map((w, idx) => (
                <div key={idx}>{w}</div>
              ))}
            </div>
          )}

          {specBusy && specProgress && <ProgressReadout progress={specProgress} />}
          {specError && <ErrorBox message={specError} />}
          {specArtifact && <ArtifactPreview artifact={specArtifact} />}

          {livePreviewEnabled && (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">
                  useMediaPreview (640px · 15fps · first 10s)
                </span>
                <button
                  type="button"
                  onClick={livePreview.regenerate}
                  disabled={livePreview.loading}
                  className="text-sky-400 hover:text-sky-300 underline"
                >
                  Regenerate
                </button>
              </div>
              {livePreview.loading && (
                <div className="flex items-center gap-2 text-xs text-sky-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Rendering low-res preview...
                </div>
              )}
              {livePreview.error && <ErrorBox message={livePreview.error} />}
              {livePreview.previewUrl && (
                <video
                  src={livePreview.previewUrl}
                  controls
                  playsInline
                  className="w-full max-h-64 rounded-lg bg-black"
                />
              )}
            </div>
          )}
        </section>
        </div>
      </main>
    </div>
  );
}

function ProgressReadout({ progress }: { progress: RenderProgress }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-slate-300">
        <span>{progress.stage}</span>
        <span className="font-mono">{progress.percent}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full bg-sky-500 transition-all duration-150"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 whitespace-pre-wrap break-words">
      <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
      <div className="min-w-0">{message}</div>
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: RenderArtifact }) {
  return (
    <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <video
        src={artifact.url}
        controls
        playsInline
        className="w-full max-h-72 rounded-lg bg-black"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
        <div className="font-mono flex flex-wrap gap-3">
          <span>Time: {(artifact.renderMs / 1000).toFixed(2)}s</span>
          <span>Size: {formatBytes(artifact.size)}</span>
        </div>
        <a
          href={artifact.url}
          download={artifact.filename}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700"
        >
          <Download className="h-3.5 w-3.5" />
          Download {artifact.filename}
        </a>
      </div>
    </div>
  );
}
