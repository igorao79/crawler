"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, Download } from "lucide-react";
import { ViewerLayout } from "@/components/viewer/viewer-layout";
import { PROXY_URL } from "@/lib/api";

export default function ViewerPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-white/[0.08] bg-background/80 backdrop-blur-md shrink-0">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#c1ff00] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <div className="h-4 w-px bg-white/[0.1]" />
        <h1 className="text-sm font-semibold">Crawler Viewer</h1>
        <span className="text-xs text-muted-foreground">crawled site</span>
        <div className="ml-auto flex items-center gap-3">
          <a
            href={`${PROXY_URL}/api/source/download-all`}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-[#c1ff00] text-black font-medium hover:bg-[#d4ff4d] transition-colors"
          >
            <Download className="h-3 w-3" />
            Download Site
          </a>
          <a
            href="#"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-[#c1ff00] transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Original
          </a>
        </div>
      </div>

      {/* Viewer */}
      <div className="flex-1 min-h-0">
        <ViewerLayout slug="" />
      </div>
    </div>
  );
}
