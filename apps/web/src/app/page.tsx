"use client";

import Link from "next/link";
import { Download } from "lucide-react";
import { PROXY_URL } from "@/lib/api";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-8rem)] space-y-10">
      {/* Hero */}
      <div className="text-center space-y-4 animate-fade-in-up animate-fade-in-up-1">
        <h1 className="text-6xl font-bold tracking-tight">
          <span className="text-[#c1ff00] glow-text-green">Web Crawler</span>
        </h1>
        <p className="text-muted-foreground text-lg">
          Universal site crawler with BFS traversal, caching proxy, and asset extraction
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-4 animate-fade-in-up animate-fade-in-up-2">
        <Link
          href="/crawl"
          className="px-8 py-3 rounded-lg bg-[#c1ff00] text-black font-semibold text-sm hover:bg-[#d4ff4d] transition-colors shadow-[0_0_30px_rgba(193,255,0,0.2)]"
        >
          Start New Crawl
        </Link>
        <Link
          href="/viewer"
          className="px-8 py-3 rounded-lg border border-white/[0.1] text-foreground font-medium text-sm hover:border-[#c1ff00]/30 hover:text-[#c1ff00] transition-all"
        >
          Open Viewer
        </Link>
        <a
          href={`${PROXY_URL}/api/source/download-all`}
          className="px-8 py-3 rounded-lg border border-white/[0.1] text-foreground font-medium text-sm hover:border-[#c1ff00]/30 hover:text-[#c1ff00] transition-all flex items-center gap-2"
        >
          <Download className="h-4 w-4" />
          Download ZIP
        </a>
      </div>

      {/* Description */}
      <div className="text-center text-xs text-muted-foreground/50 animate-fade-in-up animate-fade-in-up-3 max-w-md">
        Enter any URL to crawl the full site with BFS traversal, extract source code, assets, and more
      </div>
    </div>
  );
}
