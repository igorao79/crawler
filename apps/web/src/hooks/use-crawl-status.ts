"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface CdnWarning {
  domain: string;
  files: string[];
  framework: string | null;
}

interface CrawlProgress {
  jobId: string;
  parsed: number;
  total: number;
  currentUrl: string;
  status: string;
  cdnWarnings?: CdnWarning[];
}

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";

export function useCrawlStatus(jobId: string | null) {
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;

    const ws = new WebSocket(`${WS_BASE}/ws/crawl/${jobId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as CrawlProgress;
        setProgress(data);
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [jobId]);

  return { progress, connected, disconnect };
}
