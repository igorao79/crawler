"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProjects, type ProjectListItem } from "@/lib/api";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 12;

  useEffect(() => {
    setLoading(true);
    getProjects({
      page,
      pageSize,
      tag: activeTag ?? undefined,
      search: search || undefined,
    })
      .then((res) => {
        setProjects(res.data);
        setTotal(res.total);
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [page, search, activeTag]);

  const allTags = [...new Set(projects.flatMap((p) => p.tags))];
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between animate-fade-in-up animate-fade-in-up-1">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">
            <span className="text-[#c1ff00] glow-text-green">Projects</span>
          </h1>
          <p className="text-muted-foreground mt-1">{total} crawled projects</p>
        </div>
      </div>

      {/* Search & filters */}
      <div className="flex flex-wrap items-center gap-3 animate-fade-in-up animate-fade-in-up-2">
        <div className="relative">
          <input
            placeholder="Search projects..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-64 h-9 px-4 rounded-lg text-sm bg-white/[0.04] border border-white/[0.08] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#c1ff00]/30 focus:shadow-[0_0_15px_rgba(193,255,0,0.1)] transition-all"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {activeTag && (
            <button
              onClick={() => { setActiveTag(null); setPage(1); }}
              className="text-xs px-3 py-1 rounded-full bg-[#c1ff00]/15 text-[#c1ff00] border border-[#c1ff00]/30 hover:bg-[#c1ff00]/25 transition-all"
            >
              {activeTag} ✕
            </button>
          )}
          {allTags
            .filter((t) => t !== activeTag)
            .map((tag) => (
              <button
                key={tag}
                onClick={() => { setActiveTag(tag); setPage(1); }}
                className="text-xs px-3 py-1 rounded-full border border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground transition-all"
              >
                {tag}
              </button>
            ))}
        </div>
      </div>

      {/* Project Grid */}
      {loading ? (
        <div className="text-center text-muted-foreground py-12">Loading...</div>
      ) : projects.length === 0 ? (
        <div className="glass-card rounded-xl p-12 text-center text-muted-foreground">
          No projects found. Run a crawl first.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project, i) => (
            <Link
              key={project.id}
              href={`/projects/${project.slug}`}
              className="glass-card rounded-xl p-5 group animate-fade-in-up"
              style={{ animationDelay: `${0.1 + i * 0.03}s`, opacity: 0 }}
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold group-hover:text-[#c1ff00] transition-colors">
                  {project.title ?? project.slug}
                </h3>
                <svg className="w-4 h-4 text-muted-foreground group-hover:text-[#c1ff00] transition-colors opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              {project.description && (
                <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                  {project.description}
                </p>
              )}
              <div className="flex gap-1.5 flex-wrap mb-3">
                {project.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/60 font-mono truncate">
                {project.url}
              </p>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 rounded-lg text-sm bg-white/[0.04] border border-white/[0.08] text-muted-foreground hover:text-foreground hover:border-white/[0.15] disabled:opacity-30 transition-all"
          >
            Previous
          </button>
          <span className="text-xs text-muted-foreground font-mono">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-4 py-2 rounded-lg text-sm bg-white/[0.04] border border-white/[0.08] text-muted-foreground hover:text-foreground hover:border-white/[0.15] disabled:opacity-30 transition-all"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
