'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileAudio,
  FileImage,
  FileVideo,
  KeyRound,
  Loader2,
  Play,
  Sparkles,
  Square,
  Wand2,
} from 'lucide-react';
import { GeminiRequestError, isAbortError } from '@/lib/ai/gemini-errors';
import {
  analyzeMedia,
  type AnalyzerInputItem,
  type AnalyzerItemKind,
  type MediaAnalysis,
} from '@/lib/media/analyzer';
import {
  renderEditSpec,
  type MediaProbeResult,
  type RenderProgress,
} from '@/lib/media/compositor';
import {
  generateEditSpec,
  type EditDirectorResult,
  type EditDirectorStatus,
  type MediaItem,
} from '@/lib/media/edit-director';
import { EDIT_FORMATS, type EditFormat } from '@/lib/media/edit-types';
import { formatBytes } from '@/lib/media/process';
import { getStoredApiKey, getStoredModel } from '@/lib/storage';

export interface LabUploadedMedia {
  id: string;
  kind: 'video' | 'image' | 'audio';
  file: File;
  name: string;
  size: number;
  probe: MediaProbeResult;
}

interface AiDirectorTabProps {
  mediaItems: LabUploadedMedia[];
  mediaBlobsMap: Map<string, Blob>;
  onGoToTools: () => void;
}

interface DetailedErrorState {
  summary: string;
  userAction?: string;
  details?: string;
}

const DIRECTOR_API_KEY_STORAGE = 'motionai_api_key';
const DIRECTOR_MODEL_STORAGE = 'motionai_model';

function toDetailedError(err: unknown): DetailedErrorState {
  if (err instanceof GeminiRequestError) {
    const detailParts = [
      err.explanation,
      err.rawDetails && err.rawDetails !== err.explanation ? err.rawDetails : '',
    ].filter(Boolean);
    return {
      summary: err.message,
      userAction: err.userAction,
      details: detailParts.join('\n\n') || undefined,
    };
  }
  if (err instanceof Error) {
    return {
      summary: err.message,
      details: err.stack && err.stack !== err.message ? err.stack : undefined,
    };
  }
  return { summary: String(err) };
}

export function AiDirectorTab({
  mediaItems,
  mediaBlobsMap,
  onGoToTools,
}: AiDirectorTabProps) {
  const [apiKey, setApiKey] = useState<string>('');
  const [modelName, setModelName] = useState<string>('');
  const [showKey, setShowKey] = useState<boolean>(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const directKey =
          window.localStorage.getItem(DIRECTOR_API_KEY_STORAGE)?.trim() ?? '';
        const fallbackKey = getStoredApiKey();
        setApiKey(directKey || fallbackKey);

        const directModel =
          window.localStorage.getItem(DIRECTOR_MODEL_STORAGE)?.trim() ?? '';
        const fallbackModel = getStoredModel();
        setModelName(directModel || fallbackModel || 'gemini-2.5-flash');
      } catch {
        setModelName('gemini-2.5-flash');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    try {
      const trimmed = value.trim();
      if (trimmed) {
        window.localStorage.setItem(DIRECTOR_API_KEY_STORAGE, trimmed);
      } else {
        window.localStorage.removeItem(DIRECTOR_API_KEY_STORAGE);
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const handleModelChange = useCallback((value: string) => {
    setModelName(value);
    try {
      const trimmed = value.trim();
      if (trimmed) {
        window.localStorage.setItem(DIRECTOR_MODEL_STORAGE, trimmed);
      } else {
        window.localStorage.removeItem(DIRECTOR_MODEL_STORAGE);
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    mediaItems.map((m) => m.id)
  );
  const knownIdsRef = useRef<Set<string>>(
    new Set(mediaItems.map((m) => m.id))
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const currentIds = new Set(mediaItems.map((m) => m.id));
      const newlyAdded = mediaItems
        .map((m) => m.id)
        .filter((id) => !knownIdsRef.current.has(id));
      knownIdsRef.current = currentIds;

      setSelectedIds((prev) => {
        const filtered = prev.filter((id) => currentIds.has(id));
        return Array.from(new Set([...filtered, ...newlyAdded]));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mediaItems]);

  const toggleMediaSelection = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }, []);

  const selectedMedia = useMemo(
    () => mediaItems.filter((item) => selectedIds.includes(item.id)),
    [mediaItems, selectedIds]
  );

  const [userRequest, setUserRequest] = useState<string>('');
  const [format, setFormat] = useState<EditFormat>('9:16');
  const [targetSeconds, setTargetSeconds] = useState<number>(30);
  const [language, setLanguage] = useState<'auto' | 'en' | 'bn'>('auto');

  const [statusLabel, setStatusLabel] = useState<EditDirectorStatus | null>(
    null
  );
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [generating, setGenerating] = useState<boolean>(false);
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
  const [directorResult, setDirectorResult] =
    useState<EditDirectorResult | null>(null);
  const [aiError, setAiError] = useState<DetailedErrorState | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const [copied, setCopied] = useState<boolean>(false);
  const [rendering, setRendering] = useState<boolean>(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(
    null
  );
  const [renderError, setRenderError] = useState<DetailedErrorState | null>(
    null
  );
  const [renderedVideoUrl, setRenderedVideoUrl] = useState<string | null>(null);
  const [renderedSize, setRenderedSize] = useState<number>(0);
  const [renderedMs, setRenderedMs] = useState<number>(0);
  const renderedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (renderedUrlRef.current) {
        URL.revokeObjectURL(renderedUrlRef.current);
        renderedUrlRef.current = null;
      }
    };
  }, []);

  const handleCancelAi = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleAnalyzeMedia = useCallback(async () => {
    setAiError(null);
    if (!apiKey.trim()) {
      setAiError({
        summary: 'Set your Gemini key in the main app Settings first.',
      });
      return;
    }
    if (!modelName.trim()) {
      setAiError({ summary: 'Specify a Gemini model name first.' });
      return;
    }
    if (selectedMedia.length === 0) {
      setAiError({
        summary: 'Select at least one uploaded media file to analyze.',
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAnalyzing(true);
    setStatusLabel('Analyzing your media');

    try {
      const inputs: AnalyzerInputItem[] = selectedMedia.map((item) => ({
        mediaId: item.id,
        kind: item.kind as AnalyzerItemKind,
        name: item.name,
        blob: item.file,
        duration: item.probe.duration > 0 ? item.probe.duration : undefined,
      }));

      const res = await analyzeMedia(
        inputs,
        apiKey.trim(),
        modelName.trim(),
        controller.signal
      );
      setAnalysis(res);
    } catch (err) {
      if (!isAbortError(err)) {
        setAiError(toDetailedError(err));
      }
    } finally {
      setAnalyzing(false);
      setStatusLabel(null);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [apiKey, modelName, selectedMedia]);

  const handleGenerateSpec = useCallback(async () => {
    setAiError(null);
    if (!apiKey.trim()) {
      setAiError({
        summary: 'Set your Gemini key in the main app Settings first.',
      });
      return;
    }
    if (!modelName.trim()) {
      setAiError({ summary: 'Specify a Gemini model name first.' });
      return;
    }
    if (selectedMedia.length === 0) {
      setAiError({
        summary: 'Select at least one uploaded media file first.',
      });
      return;
    }
    if (!userRequest.trim()) {
      setAiError({ summary: 'Describe the edit you want before generating.' });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGenerating(true);
    setStatusLabel('Planning the edit');

    try {
      const mediaPayload: MediaItem[] = selectedMedia.map((item) => ({
        mediaId: item.id,
        kind: item.kind,
        name: item.name,
        size: item.size,
        duration: item.probe.duration > 0 ? item.probe.duration : undefined,
        width: item.probe.width ?? undefined,
        height: item.probe.height ?? undefined,
      }));

      const res = await generateEditSpec(
        {
          userRequest: userRequest.trim(),
          mediaItems: mediaPayload,
          analysis,
          format,
          targetSeconds,
          language,
        },
        apiKey.trim(),
        modelName.trim(),
        controller.signal,
        (stepStatus) => setStatusLabel(stepStatus)
      );

      setDirectorResult(res);
    } catch (err) {
      if (!isAbortError(err)) {
        setAiError(toDetailedError(err));
      }
    } finally {
      setGenerating(false);
      setStatusLabel(null);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [
    analysis,
    apiKey,
    format,
    language,
    modelName,
    selectedMedia,
    targetSeconds,
    userRequest,
  ]);

  const formattedSpecJson = useMemo(() => {
    if (!directorResult) return '';
    return JSON.stringify(directorResult.spec, null, 2);
  }, [directorResult]);

  const formattedAnalysisJson = useMemo(() => {
    if (!analysis) return '';
    return JSON.stringify(
      {
        items: analysis.items,
        overallMood: analysis.overallMood,
        suggestedPalette: analysis.suggestedPalette,
        suggestedMusicStyle: analysis.suggestedMusicStyle,
        warnings: analysis.warnings,
      },
      null,
      2
    );
  }, [analysis]);

  const handleCopySpec = useCallback(async () => {
    if (!formattedSpecJson) return;
    try {
      await navigator.clipboard.writeText(formattedSpecJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  }, [formattedSpecJson]);

  const handleRenderResult = useCallback(async () => {
    if (!directorResult) return;
    setRenderError(null);
    setRendering(true);
    setRenderProgress({ percent: 0, stage: 'Starting render...' });
    const started = performance.now();

    try {
      const blob = await renderEditSpec(
        directorResult.spec,
        mediaBlobsMap,
        setRenderProgress
      );
      const elapsed = Math.round(performance.now() - started);
      const nextUrl = URL.createObjectURL(blob);
      if (renderedUrlRef.current) {
        URL.revokeObjectURL(renderedUrlRef.current);
      }
      renderedUrlRef.current = nextUrl;
      setRenderedVideoUrl(nextUrl);
      setRenderedSize(blob.size);
      setRenderedMs(elapsed);
    } catch (err) {
      setRenderError(toDetailedError(err));
    } finally {
      setRendering(false);
    }
  }, [directorResult, mediaBlobsMap]);

  const busyAi = analyzing || generating;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <KeyRound className="h-5 w-5 text-sky-400 shrink-0" />
          <h2 className="text-sm sm:text-base font-semibold text-slate-100">
            A) Gemini API Credentials
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="block space-y-1">
            <span className="text-slate-400">
              API Key (<code className="text-slate-300">motionai_api_key</code>)
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder="Paste Gemini API key..."
                autoComplete="off"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-3 pr-9 py-2 text-slate-100 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </label>

          <label className="block space-y-1">
            <span className="text-slate-400">
              Model (<code className="text-slate-300">motionai_model</code>)
            </span>
            <input
              type="text"
              value={modelName}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="gemini-2.5-flash"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 font-mono"
            />
          </label>
        </div>

        {!apiKey.trim() && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <span>Set your Gemini key in the main app Settings first.</span>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm sm:text-base font-semibold text-slate-100">
            B) Media Picker ({selectedMedia.length} / {mediaItems.length} selected)
          </h2>
          {mediaItems.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelectedIds(mediaItems.map((m) => m.id))}
                className="text-sky-400 hover:text-sky-300 underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="text-slate-400 hover:text-slate-200 underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {mediaItems.length === 0 ? (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-2">
            <span>No media uploaded yet. Upload files in the Tools tab (Section B).</span>
            <button
              type="button"
              onClick={onGoToTools}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-200 hover:bg-slate-700"
            >
              Go to Tools tab
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {mediaItems.map((item) => {
              const checked = selectedIds.includes(item.id);
              const Icon =
                item.kind === 'video'
                  ? FileVideo
                  : item.kind === 'image'
                    ? FileImage
                    : FileAudio;
              return (
                <label
                  key={item.id}
                  className={`flex items-center justify-between gap-2.5 rounded-lg border p-3 text-xs cursor-pointer transition-colors ${
                    checked
                      ? 'border-sky-500/60 bg-sky-500/10'
                      : 'border-slate-800 bg-slate-950/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMediaSelection(item.id)}
                      className="accent-sky-500 shrink-0"
                    />
                    <Icon className="h-4 w-4 text-sky-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sky-300 shrink-0">
                          {item.id}
                        </span>
                        <span className="truncate font-medium text-slate-100">
                          {item.name}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">
                        {item.kind} · {formatBytes(item.size)}
                        {item.kind !== 'image' && item.probe.duration > 0
                          ? ` · ${item.probe.duration.toFixed(2)}s`
                          : ''}
                      </div>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <Wand2 className="h-5 w-5 text-sky-400 shrink-0" />
          <h2 className="text-sm sm:text-base font-semibold text-slate-100">
            C) Edit Request &amp; AI Director
          </h2>
        </div>

        <div className="space-y-3 text-xs">
          <label className="block space-y-1">
            <span className="text-slate-400">Describe the edit</span>
            <textarea
              value={userRequest}
              onChange={(e) => setUserRequest(e.target.value)}
              rows={3}
              placeholder="Assemble my clips into a 30-second highlight reel with warm tones and upbeat feel"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs sm:text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className="text-slate-400">Format</span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as EditFormat)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {EDIT_FORMATS.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {fmt}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-slate-400 font-mono">
                Target duration: {targetSeconds}s
              </span>
              <input
                type="range"
                min={5}
                max={120}
                step={1}
                value={targetSeconds}
                onChange={(e) => setTargetSeconds(Number(e.target.value))}
                className="w-full accent-sky-500 mt-2"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-slate-400">Language</span>
              <select
                value={language}
                onChange={(e) =>
                  setLanguage(e.target.value as 'auto' | 'en' | 'bn')
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="bn">Bengali</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={handleAnalyzeMedia}
              disabled={busyAi || selectedMedia.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 text-sky-400" />
              )}
              Analyze media
            </button>

            <button
              type="button"
              onClick={handleGenerateSpec}
              disabled={busyAi || selectedMedia.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              Generate edit spec
            </button>

            {busyAi && (
              <button
                type="button"
                onClick={handleCancelAi}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/20"
              >
                <Square className="h-3 w-3" />
                Cancel
              </button>
            )}

            {statusLabel && (
              <span className="text-xs font-mono text-sky-300">
                {statusLabel}...
              </span>
            )}
          </div>
        </div>

        {aiError && <DetailedErrorBox error={aiError} />}

        {analysis && (
          <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
              <span className="font-semibold">MediaAnalysis</span>
              <span className="font-mono text-[11px] text-slate-400">
                {analysis.modelName.replace(/^models\//, '')} ·{' '}
                {(analysis.elapsedMs / 1000).toFixed(2)}s
              </span>
            </div>
            <pre className="max-h-64 overflow-auto rounded bg-slate-950 p-2.5 font-mono text-[11px] text-slate-200">
              {formattedAnalysisJson}
            </pre>
          </div>
        )}
      </section>

      {directorResult && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm sm:text-base font-semibold text-slate-100">
              D) Generated EditSpec &amp; FFmpeg Render
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCopySpec}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={handleRenderResult}
                disabled={rendering}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {rendering ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Render with FFmpeg
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2 text-xs">
            <div className="text-slate-200">
              <span className="font-semibold text-sky-300">Brief: </span>
              {directorResult.brief}
            </div>
            <div className="font-mono text-[11px] text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
              <span>Calls: {directorResult.calls}</span>
              <span>
                Tokens: {directorResult.tokens.prompt} in /{' '}
                {directorResult.tokens.output} out /{' '}
                {directorResult.tokens.thinking} thinking
              </span>
              <span>Time: {(directorResult.ms / 1000).toFixed(2)}s</span>
            </div>
          </div>

          {directorResult.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
              {directorResult.warnings.map((w, idx) => (
                <div key={idx}>{w}</div>
              ))}
            </div>
          )}

          <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-200">
            {formattedSpecJson}
          </pre>

          {rendering && renderProgress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>{renderProgress.stage}</span>
                <span className="font-mono">{renderProgress.percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-150"
                  style={{ width: `${renderProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {renderError && <DetailedErrorBox error={renderError} />}

          {renderedVideoUrl && (
            <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <video
                src={renderedVideoUrl}
                controls
                playsInline
                className="w-full max-h-80 rounded-lg bg-black"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                <div className="font-mono flex gap-3">
                  <span>Render: {(renderedMs / 1000).toFixed(2)}s</span>
                  <span>Size: {formatBytes(renderedSize)}</span>
                </div>
                <a
                  href={renderedVideoUrl}
                  download="ai-director-output.mp4"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download MP4
                </a>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function DetailedErrorBox({ error }: { error: DetailedErrorState }) {
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 space-y-1.5">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium break-words">{error.summary}</div>
          {error.userAction && (
            <div className="text-rose-300/90">{error.userAction}</div>
          )}
        </div>
      </div>
      {error.details && (
        <details className="pt-1">
          <summary className="cursor-pointer font-medium text-rose-300 hover:text-rose-200">
            Details
          </summary>
          <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-slate-950/80 p-2 font-mono text-[11px] text-rose-200/90 whitespace-pre-wrap break-words">
            {error.details}
          </pre>
        </details>
      )}
    </div>
  );
}
