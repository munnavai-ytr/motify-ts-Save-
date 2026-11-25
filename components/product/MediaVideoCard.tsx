'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Film,
  Loader2,
  Pencil,
  Play,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { getMediaRecord } from '@/lib/db';
import { formatBytes } from '@/lib/media/process';
import type { MediaVideoMessage } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  notifyVideoPlayerStarted,
  registerVideoPlayer,
} from '@/lib/video/player-coordinator';

interface MediaVideoCardProps {
  message: MediaVideoMessage;
  autoLoad?: boolean;
  onRequestEdit?: (message: MediaVideoMessage) => void;
}

function sanitizeDebugPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDebugPayload);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (
        lower.includes('apikey') ||
        lower === 'api_key' ||
        lower === 'x-goog-api-key' ||
        lower === 'authorization'
      ) {
        continue;
      }
      out[k] = sanitizeDebugPayload(v);
    }
    return out;
  }
  return value;
}

export function MediaVideoCard({
  message,
  autoLoad = true,
  onRequestEdit,
}: MediaVideoCardProps) {
  const playerId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { showToast } = useToast();

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoSizeBytes, setVideoSizeBytes] = useState<number | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [loadingBlob, setLoadingBlob] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);

  const loadVideoBlob = useCallback(async () => {
    setLoadingBlob(true);
    setLoadError(null);
    try {
      const record = await getMediaRecord(message.mediaBlobKey);
      if (!record?.blob) {
        setLoadError('Saved video file was not found in local storage.');
        return;
      }
      const nextUrl = URL.createObjectURL(record.blob);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
      setVideoSizeBytes(record.blob.size);
    } catch (err: unknown) {
      setLoadError(
        err instanceof Error ? err.message : 'Could not load video from storage.'
      );
    } finally {
      setLoadingBlob(false);
    }
  }, [message.mediaBlobKey]);

  // Load poster thumbnail if available
  useEffect(() => {
    if (!message.thumbnailMediaKey) return;
    let active = true;
    let createdUrl: string | null = null;
    void getMediaRecord(message.thumbnailMediaKey)
      .then((rec) => {
        if (!active || !rec?.blob) return;
        createdUrl = URL.createObjectURL(rec.blob);
        setThumbUrl(createdUrl);
      })
      .catch(() => {
        // Non-fatal if thumbnail missing
      });
    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [message.thumbnailMediaKey]);

  // Auto-load latest version immediately; older versions load on tap to conserve memory
  useEffect(() => {
    if (!autoLoad) return;
    let active = true;
    let createdUrl: string | null = null;
    queueMicrotask(() => {
      if (active) setLoadingBlob(true);
    });
    void getMediaRecord(message.mediaBlobKey)
      .then((record) => {
        if (!active) return;
        if (!record?.blob) {
          setLoadError('Saved video file was not found in local storage.');
          return;
        }
        createdUrl = URL.createObjectURL(record.blob);
        setVideoUrl(createdUrl);
        setVideoSizeBytes(record.blob.size);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoadError(
          err instanceof Error ? err.message : 'Could not load video from storage.'
        );
      })
      .finally(() => {
        if (active) setLoadingBlob(false);
      });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [autoLoad, message.mediaBlobKey]);

  // Revoke manually loaded URL on unmount
  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  // Pause when another player starts
  useEffect(() => {
    const unregister = registerVideoPlayer(playerId, () => {
      videoRef.current?.pause();
    });
    return unregister;
  }, [playerId]);

  const handleDownload = async () => {
    if (videoUrl) {
      const a = document.createElement('a');
      a.href = videoUrl;
      a.download = `motionai-edit-v${message.version}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    setDownloadBusy(true);
    try {
      const record = await getMediaRecord(message.mediaBlobKey);
      if (!record?.blob) {
        showToast('Video file is no longer in local storage.', 'danger');
        return;
      }
      const tempUrl = URL.createObjectURL(record.blob);
      const a = document.createElement('a');
      a.href = tempUrl;
      a.download = `motionai-edit-v${message.version}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(tempUrl), 4000);
    } catch {
      showToast('Failed to download MP4.', 'danger');
    } finally {
      setDownloadBusy(false);
    }
  };

  const handleCopyDebugInfo = async () => {
    const payload = sanitizeDebugPayload({
      version: message.version,
      format: message.format,
      durationSec: message.durationSec,
      brief: message.brief,
      routerReason: message.routerReason,
      usedMediaIds: message.usedMediaIds,
      warnings: message.warnings,
      editSpec: message.editSpec,
      analysis: message.analysis
        ? {
            overallMood: message.analysis.overallMood,
            suggestedMusicStyle: message.analysis.suggestedMusicStyle,
            suggestedPalette: message.analysis.suggestedPalette,
            items: message.analysis.items,
            modelName: message.analysis.modelName,
          }
        : null,
      debugInfo: message.debugInfo,
    });
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopiedDebug(true);
      showToast('Edit debug info copied', 'success');
      window.setTimeout(() => setCopiedDebug(false), 1800);
    } catch {
      showToast('Could not copy debug info', 'danger');
    }
  };

  const isHybrid = message.editSpec.tracks.some((t) => t.kind === 'mg');

  const aspectClass =
    message.format === '9:16'
      ? 'aspect-[9/16] max-h-[60dvh] md:max-h-[420px] w-auto mx-auto'
      : message.format === '1:1'
        ? 'aspect-square max-h-[60dvh] md:max-h-[340px] w-auto mx-auto'
        : 'aspect-video w-full';

  return (
    <article
      aria-label={`Media edit video version ${message.version}`}
      className="rounded-[16px] border border-border bg-surface-1 p-4 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-medium text-text-muted tabular-nums">
              Video v{message.version}
            </span>
            <Badge variant="default">{message.format}</Badge>
            <Badge variant="accent">{message.durationSec.toFixed(1)}s</Badge>
            <Badge variant="default">
              {isHybrid ? 'Hybrid Edit' : 'Media Edit'}
            </Badge>
          </div>
          <p dir="auto" className="text-xs font-medium text-text leading-snug">
            {message.brief}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {onRequestEdit && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRequestEdit(message)}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>Edit</span>
            </Button>
          )}

          <Button
            variant="primary"
            size="sm"
            loading={downloadBusy}
            disabled={downloadBusy}
            onClick={() => void handleDownload()}
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download MP4</span>
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'relative overflow-hidden rounded-[12px] border border-border bg-black flex items-center justify-center',
          aspectClass
        )}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={thumbUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            onPlay={() => notifyVideoPlayerStarted(playerId)}
            className="h-full w-full object-contain bg-black"
          />
        ) : (
          <div className="relative flex h-full w-full flex-col items-center justify-center p-4 text-center">
            {thumbUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbUrl}
                alt={`Preview thumbnail for version ${message.version}`}
                className="absolute inset-0 h-full w-full object-cover opacity-35"
              />
            )}
            <div className="relative z-10 flex flex-col items-center gap-2">
              {loadingBlob ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                  <span className="text-xs text-text-secondary">
                    Loading rendered MP4...
                  </span>
                </>
              ) : loadError ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-warning" />
                  <p className="text-xs text-text-secondary max-w-[220px]">
                    {loadError}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void loadVideoBlob()}
                  >
                    Retry load
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadVideoBlob()}
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Load video preview</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Film className="h-3.5 w-3.5 shrink-0" />
          <span>
            {message.usedMediaIds.length}{' '}
            {message.usedMediaIds.length === 1 ? 'clip' : 'clips'} · 30 fps
            {videoSizeBytes !== null ? ` · ${formatBytes(videoSizeBytes)}` : ''}
          </span>
        </span>

        <div className="flex items-center gap-1.5">
          {message.warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setShowWarnings((prev) => !prev)}
              className="inline-flex min-h-[28px] items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11px] font-medium text-warning hover:bg-warning/10 transition-colors cursor-pointer"
            >
              <AlertTriangle className="h-3 w-3" />
              <span>
                {message.warnings.length}{' '}
                {message.warnings.length === 1 ? 'note' : 'notes'}
              </span>
              {showWarnings ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleCopyDebugInfo()}
            className="inline-flex min-h-[28px] items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text transition-colors cursor-pointer"
          >
            {copiedDebug ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            <span>{copiedDebug ? 'Copied' : 'Copy debug info'}</span>
          </button>
        </div>
      </div>

      {showWarnings && message.warnings.length > 0 && (
        <ul className="space-y-1 rounded-[10px] border border-warning/30 bg-warning/8 p-2.5 text-[11px] text-text-secondary list-disc pl-6">
          {message.warnings.map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
