import type { FFmpeg } from '@ffmpeg/ffmpeg';

interface UtilDownloadProgress {
  url: string | URL;
  total: number;
  received: number;
  delta: number;
  done: boolean;
}

export type FFmpegLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface FFmpegLoadProgress {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  loadedMB: number;
  totalMB: number;
  file: 'core' | 'wasm';
}

export type FFmpegProgressCallback = (progress: FFmpegLoadProgress) => void;

export const FFMPEG_CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
export const FFMPEG_CORE_JS_URL = `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`;
export const FFMPEG_CORE_WASM_URL = `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`;

const KNOWN_CORE_JS_BYTES = 114_494;
const KNOWN_CORE_WASM_BYTES = 32_129_114;
const BYTES_PER_MB = 1024 * 1024;
const IS_DEV = process.env.NODE_ENV === 'development';

let loadState: FFmpegLoadState = 'idle';
let ffmpegInstance: FFmpeg | null = null;
let loadingPromise: Promise<void> | null = null;
let lastError: Error | null = null;
let coreBlobUrl: string | null = null;
let wasmBlobUrl: string | null = null;

const progressListeners = new Set<FFmpegProgressCallback>();

function notifyProgress(progress: FFmpegLoadProgress): void {
  if (IS_DEV) {
    console.info(
      `[ffmpeg-loader] ${progress.file}: ${progress.percent}% (${progress.loadedMB.toFixed(2)} / ${progress.totalMB.toFixed(2)} MB)`
    );
  }
  for (const listener of progressListeners) {
    try {
      listener(progress);
    } catch (err) {
      console.error('[ffmpeg-loader] Progress listener error:', err);
    }
  }
}

export function getLoadState(): FFmpegLoadState {
  return loadState;
}

export function getLoadError(): Error | null {
  return lastError;
}

export function onProgress(cb: FFmpegProgressCallback): () => void {
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
}

export function getFFmpeg(): FFmpeg {
  if (loadState !== 'ready' || !ffmpegInstance) {
    throw new Error(
      `FFmpeg is not ready (current state: ${loadState}). Call loadFFmpeg() first.`
    );
  }
  return ffmpegInstance;
}

function cleanupBlobUrls(): void {
  if (coreBlobUrl) {
    URL.revokeObjectURL(coreBlobUrl);
    coreBlobUrl = null;
  }
  if (wasmBlobUrl) {
    URL.revokeObjectURL(wasmBlobUrl);
    wasmBlobUrl = null;
  }
}

export async function loadFFmpeg(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('FFmpeg can only be loaded in a browser environment.');
  }

  if (typeof SharedArrayBuffer === 'undefined') {
    const err = new Error(
      'FFmpeg requires SharedArrayBuffer. Check COOP/COEP headers.'
    );
    loadState = 'error';
    lastError = err;
    console.error('[ffmpeg-loader]', err.message);
    throw err;
  }

  if (loadState === 'ready' && ffmpegInstance) {
    return;
  }

  if (loadState === 'loading' && loadingPromise) {
    return loadingPromise;
  }

  loadState = 'loading';
  lastError = null;

  loadingPromise = (async () => {
    try {
      const [{ FFmpeg: FFmpegClass }, { toBlobURL }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ]);

      const instance = new FFmpegClass();

      let coreLoaded = 0;
      let coreTotal = KNOWN_CORE_JS_BYTES;
      let wasmLoaded = 0;
      let wasmTotal = KNOWN_CORE_WASM_BYTES;

      const emitCombinedProgress = (file: 'core' | 'wasm'): void => {
        const loadedBytes = coreLoaded + wasmLoaded;
        const totalBytes = coreTotal + wasmTotal;
        const percent =
          totalBytes > 0
            ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100))
            : 0;
        notifyProgress({
          percent,
          loadedBytes,
          totalBytes,
          loadedMB: loadedBytes / BYTES_PER_MB,
          totalMB: totalBytes / BYTES_PER_MB,
          file,
        });
      };

      cleanupBlobUrls();

      coreBlobUrl = await toBlobURL(
        FFMPEG_CORE_JS_URL,
        'text/javascript',
        true,
        (event: UtilDownloadProgress) => {
          coreLoaded = event.received;
          if (event.total > 0) {
            coreTotal = event.total;
          } else if (event.done && event.received > 0) {
            coreTotal = event.received;
          }
          emitCombinedProgress('core');
        }
      );

      wasmBlobUrl = await toBlobURL(
        FFMPEG_CORE_WASM_URL,
        'application/wasm',
        true,
        (event: UtilDownloadProgress) => {
          wasmLoaded = event.received;
          if (event.total > 0) {
            wasmTotal = event.total;
          } else if (event.done && event.received > 0) {
            wasmTotal = event.received;
          }
          emitCombinedProgress('wasm');
        }
      );

      await instance.load({
        coreURL: coreBlobUrl,
        wasmURL: wasmBlobUrl,
      });

      ffmpegInstance = instance;
      loadState = 'ready';

      const finalTotal = coreTotal + wasmTotal;
      notifyProgress({
        percent: 100,
        loadedBytes: finalTotal,
        totalBytes: finalTotal,
        loadedMB: finalTotal / BYTES_PER_MB,
        totalMB: finalTotal / BYTES_PER_MB,
        file: 'wasm',
      });
    } catch (rawErr) {
      cleanupBlobUrls();
      ffmpegInstance = null;
      loadState = 'error';
      const err =
        rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      lastError = err;
      console.error('[ffmpeg-loader] Failed to load FFmpeg:', err);
      throw err;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}
