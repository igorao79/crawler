"use client";

import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { startCrawl, cancelCrawl, PROXY_URL } from "@/lib/api";
import { useCrawlStatus } from "@/hooks/use-crawl-status";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export default function CrawlPage() {
  const [targetUrl, setTargetUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { progress, connected } = useCrawlStatus(jobId);

  const isRunning = progress?.status === "running";
  const isDone = progress?.status === "done";
  const isError = progress?.status === "error";

  // Timer — start immediately when job starts, stop when done/error
  const timerActive = !!jobId && !isDone && !isError;
  useEffect(() => {
    if (timerActive) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timerActive]);

  const lastLoggedUrl = useRef<string>("");
  useEffect(() => {
    if (progress?.currentUrl && progress.currentUrl !== lastLoggedUrl.current) {
      lastLoggedUrl.current = progress.currentUrl;
      setLogs((prev) => [...prev, progress.currentUrl]);
    }
  }, [progress?.currentUrl]);

  function normalizeUrl(url: string): string {
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  }

  function validateUrl(url: string): boolean {
    try {
      const parsed = new URL(normalizeUrl(url));
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function handleStart() {
    if (!targetUrl.trim()) {
      setError("Enter a URL to crawl");
      return;
    }
    if (!validateUrl(targetUrl)) {
      setError("Invalid URL");
      return;
    }

    const crawlUrl = normalizeUrl(targetUrl);
    setStarting(true);
    setError(null);
    setLogs([]);
    setElapsed(0);
    try {
      const job = await startCrawl(crawlUrl, maxDepth);
      setJobId(job.id);
      setLogs([`Crawl started: ${crawlUrl}`]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start crawl");
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!jobId) return;
    try {
      await cancelCrawl(jobId);
      setLogs((prev) => [...prev, "Crawl cancelled"]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.parsed / progress.total) * 100)
      : 0;

  const showProgress = !!jobId;

  return (
    <div className="space-y-8 pt-4">
      {/* Header */}
      <div className="animate-fade-in-up animate-fade-in-up-1">
        <h1 className="text-4xl font-bold tracking-tighter mb-1">New Crawl</h1>
        <p className="text-muted-foreground text-sm">
          Enter a URL and select crawl depth. All pages and assets will be cached.
        </p>
      </div>

      {/* URL + Controls */}
      <div className="animate-fade-in-up animate-fade-in-up-2 space-y-4">
        <input
          type="url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isRunning && handleStart()}
          placeholder="example.com"
          disabled={isRunning}
          autoFocus
          className="w-full px-5 py-4 rounded-xl bg-white/[0.03] border border-white/[0.07] text-base font-mono text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-[#6366f1]/50 focus:ring-2 focus:ring-[#6366f1]/20 transition-all disabled:opacity-40"
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Depth</span>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((d) => (
                <button
                  key={d}
                  onClick={() => setMaxDepth(d)}
                  disabled={isRunning}
                  className={`w-9 h-9 rounded-lg text-xs font-mono font-medium transition-all ${
                    d === maxDepth
                      ? "bg-[#6366f1] text-white shadow-[0_0_16px_rgba(99,102,241,0.3)]"
                      : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isRunning && (
              <button
                onClick={handleCancel}
                className="px-4 py-2.5 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleStart}
              disabled={starting || isRunning}
              className="btn-accent px-7 py-2.5 rounded-lg text-xs disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {starting ? "Starting..." : isRunning ? "Crawling..." : "Start"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/15 px-4 py-2.5 rounded-lg">{error}</p>
        )}
      </div>

      {/* Progress */}
      {showProgress && (
        <div className="animate-fade-in-up animate-fade-in-up-3 space-y-5">
          {/* Timer + Status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className={`status-dot ${isDone ? "" : isError ? "status-dot-error" : ""}`} />
              <span className="text-sm">
                {isDone ? (
                  <span className="text-[#22c55e]">Complete</span>
                ) : isError ? (
                  <span className="text-red-400">Error</span>
                ) : (
                  <span className="text-foreground/70">Crawling...</span>
                )}
              </span>
            </div>
            <span className="font-mono text-xl font-semibold text-muted-foreground tabular-nums">
              {formatTime(elapsed)}
            </span>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
              <div className="text-3xl font-bold font-mono text-foreground">
                {progress?.total ?? 0}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Found</div>
            </div>
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
              <div className="text-3xl font-bold font-mono text-[#6366f1]">
                {progress?.parsed ?? 0}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Parsed</div>
            </div>
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
              <div className="text-3xl font-bold font-mono text-foreground">
                {progressPercent}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">Progress</div>
            </div>
          </div>

          {/* Progress bar */}
          <div>
            <div className="relative h-2 rounded-full bg-white/[0.05] overflow-hidden">
              <div
                className="progress-bar h-full rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {progress?.currentUrl && (
              <p className="text-xs text-muted-foreground/40 font-mono mt-2 truncate">
                {progress.currentUrl}
              </p>
            )}
          </div>

          {/* Download */}
          {isDone && (
            <a
              href={`${PROXY_URL}/api/source/download-all?domain=${encodeURIComponent(new URL(normalizeUrl(targetUrl)).hostname)}&url=${encodeURIComponent(normalizeUrl(targetUrl))}`}
              className="btn-accent flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl text-sm font-semibold w-full"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download ZIP
            </a>
          )}

          {/* CDN Warnings */}
          {progress?.cdnWarnings && progress.cdnWarnings.length > 0 && (
            <div className="rounded-xl bg-amber-500/[0.06] border border-amber-500/20 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
                  External CDN Assets Detected
                </span>
              </div>
              <p className="text-xs text-amber-200/60">
                These files are loaded from external CDNs and are cached locally. Some may require the original server to function.
              </p>
              {progress.cdnWarnings.map((w, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-amber-300/80">{w.domain}</span>
                    {w.framework && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">
                        {w.framework}
                      </span>
                    )}
                    <span className="text-[10px] text-amber-200/40">{w.files.length} file{w.files.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="pl-3 space-y-0.5">
                    {w.files.slice(0, 5).map((f, j) => (
                      <div key={j} className="text-[11px] font-mono text-amber-200/40 truncate">{f}</div>
                    ))}
                    {w.files.length > 5 && (
                      <div className="text-[10px] text-amber-200/30">+{w.files.length - 5} more</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div className="animate-fade-in-up animate-fade-in-up-4">
          <div className="rounded-xl overflow-hidden bg-white/[0.015] border border-white/[0.05]">
            <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/[0.05]">
              <div className="w-2 h-2 rounded-full bg-red-400/50" />
              <div className="w-2 h-2 rounded-full bg-yellow-400/50" />
              <div className="w-2 h-2 rounded-full bg-green-400/50" />
              <span className="text-[10px] text-muted-foreground/30 ml-2 font-mono">
                log &middot; {logs.length}
              </span>
            </div>
            <ScrollArea className="h-48 p-4">
              <div className="terminal-log space-y-0.5">
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.startsWith("Crawl cancelled") ? "log-error" :
                      log.startsWith("Crawl started") ? "log-info" : "log-success"
                    }
                  >
                    {log}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
}
