"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { startCrawl, cancelCrawl } from "@/lib/api";
import { useCrawlStatus } from "@/hooks/use-crawl-status";

export default function CrawlPage() {
  const [maxDepth, setMaxDepth] = useState(3);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const { progress, connected } = useCrawlStatus(jobId);

  const isRunning = progress?.status === "running";
  const isDone = progress?.status === "done";
  const isError = progress?.status === "error";

  // Track current URL changes via ref to avoid infinite re-renders
  const lastLoggedUrl = useRef<string>("");
  useEffect(() => {
    if (progress?.currentUrl && progress.currentUrl !== lastLoggedUrl.current) {
      lastLoggedUrl.current = progress.currentUrl;
      setLogs((prev) => [...prev, `Parsing: ${progress.currentUrl}`]);
    }
  }, [progress?.currentUrl]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    setLogs([]);
    try {
      const job = await startCrawl(maxDepth);
      setJobId(job.id);
      setLogs((prev) => [...prev, `Crawl started: ${job.id}`]);
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Crawl Manager</h1>

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium w-32">Max Depth (1-5)</label>
            <Input
              type="number"
              min={1}
              max={5}
              value={maxDepth}
              onChange={(e) => setMaxDepth(Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              className="w-24"
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={handleStart} disabled={starting || isRunning}>
              {starting ? "Starting..." : "Start Crawl"}
            </Button>
            {isRunning && (
              <Button variant="destructive" onClick={handleCancel}>
                Cancel
              </Button>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {/* Progress */}
      {jobId && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Progress</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant={connected ? "default" : "secondary"}>
                {connected ? "Connected" : "Disconnected"}
              </Badge>
              <Badge
                variant={
                  isDone ? "default" : isError ? "destructive" : "secondary"
                }
              >
                {progress?.status ?? "pending"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>
                  {progress?.parsed ?? 0} / {progress?.total ?? 0} pages
                </span>
                <span>{progressPercent}%</span>
              </div>
              <Progress value={progressPercent} />
            </div>

            {progress?.currentUrl && (
              <p className="text-sm text-muted-foreground truncate">
                Current: {progress.currentUrl}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Crawl Log</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded-md border p-4">
              <div className="space-y-1 font-mono text-xs">
                {logs.map((log, i) => (
                  <div key={i} className="text-muted-foreground">
                    {log}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
