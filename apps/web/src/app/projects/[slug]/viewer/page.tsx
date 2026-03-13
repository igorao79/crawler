"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Download } from "lucide-react";
import { ViewerLayout } from "@/components/viewer/viewer-layout";
import { getProject, PROXY_URL, type ProjectDetail } from "@/lib/api";

export default function ViewerPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    getProject(slug)
      .then(setProject)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)] text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-white/[0.08] bg-background/80 backdrop-blur-md shrink-0">
        <Link
          href="/projects"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#c1ff00] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <div className="h-4 w-px bg-white/[0.1]" />
        <h1 className="text-sm font-semibold truncate">
          {project?.title ?? slug}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          <a
            href={`${PROXY_URL}/api/source/download-all`}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-[#c1ff00] text-black font-medium hover:bg-[#d4ff4d] transition-colors"
          >
            <Download className="h-3 w-3" />
            Download Site
          </a>
          {project?.url && (
            <a
              href={project.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-[#c1ff00] transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              Original
            </a>
          )}
        </div>
      </div>

      {/* Viewer */}
      <div className="flex-1 min-h-0">
        <ViewerLayout slug={slug} />
      </div>
    </div>
  );
}
