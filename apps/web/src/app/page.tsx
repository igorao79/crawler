"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getProjects, startCrawl, type PaginatedProjects, type CrawlJobResponse, getCrawlStatus } from "@/lib/api";

export default function DashboardPage() {
  const [projects, setProjects] = useState<PaginatedProjects | null>(null);
  const [lastJob, setLastJob] = useState<CrawlJobResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getProjects({ pageSize: 5 })
      .then(setProjects)
      .catch(() => {});
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
    <div className="space-y-8">
      {/* Hero section */}
      <div className="animate-fade-in-up animate-fade-in-up-1">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">
              <span className="text-[#c1ff00] glow-text-green">Dashboard</span>
            </h1>
            <p className="text-muted-foreground mt-2">
              Crawl, cache & extract source from lusion.co projects
            </p>
          </div>
          <button
            onClick={handleStartCrawl}
            disabled={loading}
            className="btn-neon px-6 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Starting..." : "Start Crawl"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up animate-fade-in-up-2">
        {[
          {
            label: "Total Projects",
            value: projects?.total ?? 0,
            color: "#c1ff00",
          },
          {
            label: "Last Crawl",
            value: lastJob?.status ?? "—",
            color: lastJob?.status === "done" ? "#c1ff00" : "#1a2ffb",
            isBadge: true,
          },
          {
            label: "Pages Parsed",
            value: lastJob?.parsedPages ?? 0,
            color: "#8832f7",
          },
        ].map((stat) => (
          <div key={stat.label} className="glass-card rounded-xl p-5">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              {stat.label}
            </div>
            {stat.isBadge ? (
              <Badge
                variant="outline"
                className="border-current"
                style={{ color: stat.color }}
              >
                <span className="neon-dot mr-2" style={{ background: stat.color, boxShadow: `0 0 6px ${stat.color}` }} />
                {String(stat.value)}
              </Badge>
            ) : (
              <div
                className="text-3xl font-bold"
                style={{ color: stat.color, textShadow: `0 0 30px ${stat.color}40` }}
              >
                {stat.value}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Recent Projects */}
      <div className="animate-fade-in-up animate-fade-in-up-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
          Recent Projects
        </h2>
        {projects && projects.data.length > 0 ? (
          <div className="space-y-2">
            {projects.data.map((p, i) => (
              <Link
                key={p.id}
                href={`/projects/${p.slug}`}
                className="glass-card flex items-center justify-between p-4 rounded-xl group animate-fade-in-up"
                style={{ animationDelay: `${0.2 + i * 0.05}s`, opacity: 0 }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-8 rounded-full bg-gradient-to-b from-[#c1ff00] to-[#1a2ffb] opacity-50 group-hover:opacity-100 transition-opacity" />
                  <div>
                    <div className="font-medium group-hover:text-[#c1ff00] transition-colors">
                      {p.title ?? p.slug}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {p.url}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {p.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="glass-card rounded-xl p-8 text-center text-muted-foreground text-sm">
            No projects yet. Start a crawl to begin.
          </div>
        )}
      </div>
    </div>
  );
}
