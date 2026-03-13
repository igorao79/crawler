"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ViewerLayout } from "@/components/viewer/viewer-layout";
import { getProject, type ProjectDetail } from "@/lib/api";

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
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-background shrink-0">
        <Link
          href={`/projects/${slug}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-sm font-semibold truncate">
          {project?.title ?? slug}
        </h1>
        <span className="text-xs text-muted-foreground">
          Preview + Source Code
        </span>
      </div>

      {/* Viewer */}
      <div className="flex-1 min-h-0">
        <ViewerLayout slug={slug} />
      </div>
    </div>
  );
}
