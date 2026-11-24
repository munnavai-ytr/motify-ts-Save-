'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderEditSpec } from './compositor';
import type { EditSpec } from './edit-types';

export interface UseMediaPreviewResult {
  previewUrl: string | null;
  loading: boolean;
  error: string | null;
  regenerate: () => void;
}

function getMediaBlobsSignature(mediaBlobs: Map<string, Blob>): string {
  const parts: string[] = [];
  for (const [id, blob] of mediaBlobs.entries()) {
    parts.push(`${id}:${blob.size}:${blob.type}`);
  }
  parts.sort();
  return parts.join('|');
}

export function useMediaPreview(
  spec: EditSpec | null,
  mediaBlobs: Map<string, Blob>
): UseMediaPreviewResult {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const specRef = useRef<EditSpec | null>(spec);
  const blobsRef = useRef<Map<string, Blob>>(mediaBlobs);
  const previewUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const tokenRef = useRef<number>(0);

  const specSignature = useMemo(() => {
    if (!spec) return '';
    try {
      return JSON.stringify(spec);
    } catch {
      return '';
    }
  }, [spec]);

  const blobsSignature = useMemo(
    () => getMediaBlobsSignature(mediaBlobs),
    [mediaBlobs]
  );

  const revokeCurrentUrl = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  const executeRender = useCallback(async () => {
    const activeSpec = specRef.current;
    const activeBlobs = blobsRef.current;

    if (!activeSpec) {
      revokeCurrentUrl();
      setPreviewUrl(null);
      setError(null);
      setLoading(false);
      return;
    }

    const token = ++tokenRef.current;
    setLoading(true);
    setError(null);

    try {
      const outputBlob = await renderEditSpec(
        activeSpec,
        activeBlobs,
        () => {},
        {
          maxWidth: 640,
          fps: 15,
          maxDuration: 10,
          preset: 'ultrafast',
        }
      );

      if (token !== tokenRef.current) {
        return;
      }

      const nextUrl = URL.createObjectURL(outputBlob);
      revokeCurrentUrl();
      previewUrlRef.current = nextUrl;
      setPreviewUrl(nextUrl);
      setLoading(false);
    } catch (rawErr) {
      if (token !== tokenRef.current) {
        return;
      }
      const message =
        rawErr instanceof Error ? rawErr.message : String(rawErr);
      setError(message);
      setLoading(false);
    }
  }, [revokeCurrentUrl]);

  const regenerate = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void executeRender();
  }, [executeRender]);

  useEffect(() => {
    specRef.current = spec;
    blobsRef.current = mediaBlobs;
  }, [spec, mediaBlobs]);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!specSignature) {
      tokenRef.current += 1;
      timerRef.current = window.setTimeout(() => {
        revokeCurrentUrl();
        setPreviewUrl(null);
        setError(null);
        setLoading(false);
      }, 0);
      return () => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void executeRender();
    }, 1000);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [specSignature, blobsSignature, executeRender, revokeCurrentUrl]);

  useEffect(() => {
    return () => {
      tokenRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      revokeCurrentUrl();
    };
  }, [revokeCurrentUrl]);

  return {
    previewUrl,
    loading,
    error,
    regenerate,
  };
}
