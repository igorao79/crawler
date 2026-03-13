"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProjects, type ProjectListItem } from "@/lib/api";

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjects({ pageSize: 50 })
      .then((res) => setProjects(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="animate-fade-in-up animate-fade-in-up-1">
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="text-[#c1ff00] glow-text-green">Lusion</span>{" "}
          <span className="text-foreground/80">Crawler</span>
        </h1>
        <p className="text-muted-foreground mt-2">
          {projects.length} projects crawled · source code, 3D assets, shaders
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 animate-fade-in-up animate-fade-in-up-2">
        {[
          { label: "Projects", value: projects.length, color: "#c1ff00" },
          { label: "3D Models", value: "54", color: "#00d4ff" },
          { label: "GLSL Shaders", value: "76", color: "#8832f7" },
          { label: "Total Assets", value: "336", color: "#1a2ffb" },
        ].map((stat) => (
          <div key={stat.label} className="glass-card rounded-xl p-4">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {stat.label}
            </div>
            <div
              className="text-2xl font-bold"
              style={{ color: stat.color, textShadow: `0 0 30px ${stat.color}40` }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* All Projects */}
      <div className="animate-fade-in-up animate-fade-in-up-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
          All Projects
        </h2>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-[#c1ff00]/30 border-t-[#c1ff00] rounded-full animate-spin" />
          </div>
        ) : projects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((p, i) => (
              <Link
                key={p.id}
                href={`/projects/${p.slug}/viewer`}
                className="glass-card rounded-xl p-4 group animate-fade-in-up"
                style={{ animationDelay: `${0.15 + i * 0.03}s`, opacity: 0 }}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-sm group-hover:text-[#c1ff00] transition-colors truncate pr-2">
                    {p.title ?? p.slug}
                  </h3>
                  <svg
                    className="w-4 h-4 text-muted-foreground group-hover:text-[#c1ff00] transition-all opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                {p.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                    {p.description}
                  </p>
                )}
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {p.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground/50 font-mono truncate">
                  {p.url}
                </p>
              </Link>
            ))}
          </div>
        ) : (
          <div className="glass-card rounded-xl p-12 text-center text-muted-foreground text-sm">
            No projects found. Run a crawl first.
          </div>
        )}
      </div>
    </div>
  );
}
