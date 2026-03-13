"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getProjects, startCrawl, type PaginatedProjects, type CrawlJobResponse, getCrawlStatus } from "@/lib/api";

export default function DashboardPage() {
  const [projects, setProjects] = useState<PaginatedProjects | null>(null);
  const [lastJob, setLastJob] = useState<CrawlJobResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getProjects({ pageSize: 5 })
      .then(setProjects)
      .catch(() => {/* server may not be running */});
  }, []);

  async function handleStartCrawl() {
    setLoading(true);
    try {
      const job = await startCrawl(3);
      const status = await getCrawlStatus(job.id);
      setLastJob(status);
    } catch (err) {
      console.error("Failed to start crawl:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button onClick={handleStartCrawl} disabled={loading}>
          {loading ? "Starting..." : "Start Crawl"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Projects
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{projects?.total ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last Crawl Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={lastJob?.status === "done" ? "default" : "secondary"}>
              {lastJob?.status ?? "No crawls yet"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pages Parsed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{lastJob?.parsedPages ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Projects</CardTitle>
        </CardHeader>
        <CardContent>
          {projects && projects.data.length > 0 ? (
            <div className="space-y-2">
              {projects.data.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.slug}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-accent transition-colors"
                >
                  <div>
                    <div className="font-medium">{p.title ?? p.slug}</div>
                    <div className="text-sm text-muted-foreground">{p.url}</div>
                  </div>
                  <div className="flex gap-1">
                    {p.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No projects yet. Start a crawl to begin.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
