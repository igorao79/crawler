"use client";

import { useState, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { startCrawl, cancelCrawl } from "@/lib/api";
import { useCrawlStatus } from "@/hooks/use-crawl-status";

export default function CrawlPage() {
  const [targetUrl, setTargetUrl] = useState("https://");
  const [maxDepth, setMaxDepth] = useState(3);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const { progress, connected } = useCrawlStatus(jobId);

  const isRunning = progress?.status === "running";
  const isDone = progress?.status === "done";
  const isError = progress?.status === "error";

  const lastLoggedUrl = useRef<string>("");
  useEffect(() => {
    if (progress?.currentUrl && progress.currentUrl !== lastLoggedUrl.current) {
      lastLoggedUrl.current = progress.currentUrl;
      setLogs((prev) => [...prev, `[OK] ${progress.currentUrl}`]);
    }
  }, [progress?.currentUrl]);

  function validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function handleStart() {
    if (!validateUrl(targetUrl)) {
      setError("Please enter a valid URL (e.g. https://example.com)");
      return;
    }

    setStarting(true);
    setError(null);
    setLogs([]);
    try {
      const job = await startCrawl(targetUrl, maxDepth);
      setJobId(job.id);
      setLogs([`> Crawl initiated [${job.id.slice(0, 8)}]`, `> Max depth: ${maxDepth}`, `> Target: ${targetUrl}`]);
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
      setLogs((prev) => [...prev, "[!] Crawl cancelled by user"]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.parsed / progress.total) * 100)
      : 0;

  return (
    <div className="space-y-8">
      <div className="animate-fade-in-up animate-fade-in-up-1">
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="text-[#c1ff00] glow-text-green">Crawl</span>
          <span className="text-muted-foreground font-light ml-2">Manager</span>
        </h1>
      </div>

      {/* Controls */}
      <div className="glass-card rounded-xl p-6 animate-fade-in-up animate-fade-in-up-2">
        {/* URL input */}
        <div className="mb-4">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 block">
            Target URL
          </label>
          <input
            type="url"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://example.com"
            disabled={isRunning}
            className="w-full px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-[#c1ff00]/40 focus:ring-1 focus:ring-[#c1ff00]/20 transition-all disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Depth
            </label>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((d) => (
                <button
                  key={d}
                  onClick={() => setMaxDepth(d)}
                  className={`w-8 h-8 rounded-lg text-sm font-mono transition-all ${
                    d === maxDepth
                      ? "bg-[#c1ff00] text-[#050510] font-bold shadow-[0_0_15px_rgba(193,255,0,0.3)]"
                      : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            {isRunning && (
              <button
                onClick={handleCancel}
                className="px-4 py-2 rounded-lg text-sm bg-[#ff4c41]/10 text-[#ff4c41] border border-[#ff4c41]/20 hover:bg-[#ff4c41]/20 transition-all"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleStart}
              disabled={starting || isRunning}
              className="btn-neon px-6 py-2 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {starting ? "Starting..." : isRunning ? "Running..." : "Execute Crawl"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-[#ff4c41] mt-3">{error}</p>
        )}
      </div>

      {/* Progress */}
      {jobId && (
        <div className="glass-card rounded-xl p-6 animate-fade-in-up animate-fade-in-up-3">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Progress
              </span>
              <div className="flex items-center gap-2">
                <span className={`neon-dot ${connected ? "" : "neon-dot-red"}`} />
                <span className="text-xs text-muted-foreground">
                  {connected ? "Connected" : "Disconnected"}
                </span>
              </div>
            </div>
            <Badge
              variant="outline"
              className="border-current"
              style={{
                color: isDone ? "#c1ff00" : isError ? "#ff4c41" : "#1a2ffb",
              }}
            >
              {progress?.status ?? "pending"}
            </Badge>
          </div>

          {/* Custom progress bar */}
          <div className="relative h-2 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="progress-neon h-full rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground font-mono">
            <span>{progress?.parsed ?? 0} / {progress?.total ?? 0} pages</span>
            <span>{progressPercent}%</span>
          </div>

          {progress?.currentUrl && (
            <p className="text-xs text-muted-foreground font-mono mt-3 truncate">
              &gt; {progress.currentUrl}
            </p>
          )}
        </div>
      )}

      {/* Terminal-style logs */}
      {logs.length > 0 && (
        <div className="animate-fade-in-up animate-fade-in-up-4">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Crawl Log
          </div>
          <div className="glass-card rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06]">
              <div className="w-2.5 h-2.5 rounded-full bg-[#ff4c41]/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#c1ff00]/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#1a2ffb]/60" />
              <span className="text-[10px] text-muted-foreground ml-2 font-mono">
                crawler
              </span>
            </div>
            <ScrollArea className="h-64 p-4">
              <div className="terminal-log space-y-0.5">
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.startsWith("[OK]") ? "log-success" :
                      log.startsWith("[!]") ? "log-error" :
                      log.startsWith(">") ? "log-info" : ""
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
