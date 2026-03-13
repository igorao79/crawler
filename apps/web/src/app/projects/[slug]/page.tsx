"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getProject, type ProjectDetail } from "@/lib/api";

export default function ProjectDetailPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("meta");

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    getProject(slug)
      .then(setProject)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground animate-fade-in-up">
        Loading...
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="text-center py-24 animate-fade-in-up">
        <p className="text-red-400">{error ?? "Project not found"}</p>
        <Link href="/projects" className="text-sm text-muted-foreground hover:text-[#c1ff00] mt-3 inline-block transition-colors">
          ← Back to projects
        </Link>
      </div>
    );
  }

  const assetsByType = project.assets.reduce<Record<string, typeof project.assets>>((acc, asset) => {
    const type = asset.type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(asset);
    return acc;
  }, {});

  const tabs = [
    { id: "meta", label: "Meta" },
    { id: "assets", label: `Assets (${project.assets.length})` },
    { id: "pages", label: `Pages (${project.pages.length})` },
    { id: "html", label: "HTML Preview" },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-fade-in-up animate-fade-in-up-1">
        <Link
          href="/projects"
          className="text-sm text-muted-foreground hover:text-[#c1ff00] transition-colors"
        >
          ← Back to projects
        </Link>
        <div className="flex items-start justify-between mt-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              <span className="text-[#c1ff00] glow-text-green">
                {project.title ?? project.slug}
              </span>
            </h1>
            {project.description && (
              <p className="text-muted-foreground mt-1 max-w-2xl">{project.description}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5 flex-wrap">
              {project.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-2.5 py-0.5 rounded-full border border-white/10 text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
            <Link
              href={`/projects/${slug}/viewer`}
              className="btn-neon px-5 py-2 rounded-lg text-sm"
            >
              Open Viewer
            </Link>
          </div>
        </div>
      </div>

      {/* Separator */}
      <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent animate-fade-in-up animate-fade-in-up-2" />

      {/* Tabs */}
      <div className="animate-fade-in-up animate-fade-in-up-2">
        <div className="flex border-b border-white/[0.08]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`tab-neon ${activeTab === tab.id ? "active" : ""}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="animate-fade-in-up animate-fade-in-up-3">
        {/* Meta Tab */}
        {activeTab === "meta" && (
          <div className="glass-card rounded-xl p-6">
            <h2 className="text-sm font-semibold text-[#c1ff00] mb-4">Project Info</h2>
            <div className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-sm">
              <span className="text-muted-foreground">URL</span>
              <a
                href={project.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#1a2ffb] hover:text-[#c1ff00] truncate transition-colors"
              >
                {project.url}
              </a>
              <span className="text-muted-foreground">Slug</span>
              <span className="font-mono text-foreground/80">{project.slug}</span>
              <span className="text-muted-foreground">Scripts</span>
              <span>{project.scripts.length}</span>
              <span className="text-muted-foreground">Stylesheets</span>
              <span>{project.stylesheets.length}</span>
              <span className="text-muted-foreground">Created</span>
              <span>{project.createdAt ?? "N/A"}</span>
            </div>
          </div>
        )}

        {/* Assets Tab */}
        {activeTab === "assets" && (
          <div className="space-y-4">
            {Object.entries(assetsByType).map(([type, typeAssets]) => (
              <div key={type} className="glass-card rounded-xl p-5">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-xs px-3 py-1 rounded-full bg-[#c1ff00]/15 text-[#c1ff00] border border-[#c1ff00]/30 font-semibold uppercase">
                    {type}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {typeAssets.length} items
                  </span>
                </div>
                <ScrollArea className="max-h-64">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        <th className="text-left py-2 text-muted-foreground font-medium text-xs">URL</th>
                        <th className="text-right py-2 text-muted-foreground font-medium text-xs w-24">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typeAssets.map((asset) => (
                        <tr key={asset.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                          <td className="py-2 pr-4 truncate max-w-md">
                            <a
                              href={asset.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-mono text-muted-foreground hover:text-[#c1ff00] transition-colors"
                            >
                              {asset.url}
                            </a>
                          </td>
                          <td className="py-2 text-right text-xs text-muted-foreground/60 font-mono">
                            {asset.sizeBytes ? `${(asset.sizeBytes / 1024).toFixed(1)} KB` : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              </div>
            ))}
            {project.assets.length === 0 && (
              <div className="glass-card rounded-xl p-12 text-center text-muted-foreground text-sm">
                No assets found
              </div>
            )}
          </div>
        )}

        {/* Pages Tab */}
        {activeTab === "pages" && (
          <div className="glass-card rounded-xl p-5">
            {project.pages.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left py-2 text-muted-foreground font-medium text-xs">URL</th>
                    <th className="text-center py-2 text-muted-foreground font-medium text-xs w-20">Depth</th>
                    <th className="text-right py-2 text-muted-foreground font-medium text-xs w-24">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {project.pages.map((pg) => (
                    <tr key={pg.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 truncate max-w-md text-xs font-mono text-muted-foreground">
                        {pg.url}
                      </td>
                      <td className="py-2 text-center text-xs">{pg.depth}</td>
                      <td className="py-2 text-right">
                        <span
                          className={`text-[10px] px-2.5 py-0.5 rounded-full ${
                            pg.status === "parsed"
                              ? "bg-[#c1ff00]/15 text-[#c1ff00] border border-[#c1ff00]/30"
                              : "bg-white/[0.06] text-muted-foreground border border-white/10"
                          }`}
                        >
                          {pg.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-8">
                No sub-pages found
              </p>
            )}
          </div>
        )}

        {/* HTML Preview Tab */}
        {activeTab === "html" && (
          <div className="glass-card rounded-xl p-5">
            {project.fullHtml ? (
              <ScrollArea className="h-[600px] rounded-lg border border-white/[0.06]">
                <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground/70 leading-relaxed">
                  {project.fullHtml.slice(0, 50000)}
                  {project.fullHtml.length > 50000 && "\n\n... (truncated)"}
                </pre>
              </ScrollArea>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-8">
                No HTML content available
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
