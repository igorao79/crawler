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
          <span className="text-[#c1ff00] glow-text-green">lusion.co</span>
        </h1>
        <p className="text-muted-foreground text-lg">
          Full site crawl · 18 pages · depth 2 · source code, shaders, 3D assets
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-2xl animate-fade-in-up animate-fade-in-up-2">
        {[
          { label: "Pages", value: "18", color: "#c1ff00" },
          { label: "3D Models", value: "54", color: "#00d4ff" },
          { label: "GLSL Shaders", value: "76", color: "#8832f7" },
          { label: "Total Assets", value: "336", color: "#1a2ffb" },
        ].map((stat) => (
          <div key={stat.label} className="glass-card rounded-xl p-4 text-center">
            <div
              className="text-3xl font-bold mb-1"
              style={{ color: stat.color, textShadow: `0 0 30px ${stat.color}40` }}
            >
              {stat.value}
            </div>
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-4 animate-fade-in-up animate-fade-in-up-3">
        <Link
          href="/viewer"
          className="px-8 py-3 rounded-lg bg-[#c1ff00] text-black font-semibold text-sm hover:bg-[#d4ff4d] transition-colors shadow-[0_0_30px_rgba(193,255,0,0.2)]"
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

      {/* Site structure hint */}
      <div className="text-center text-xs text-muted-foreground/50 animate-fade-in-up animate-fade-in-up-4 max-w-md">
        Crawled from lusion.co with BFS depth-5 traversal · Deobfuscated JS/CSS · Extracted GLSL shaders · Full asset index
      </div>
    </div>
  );
}
