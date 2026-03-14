"use client";

import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-10rem)] gap-12">
      <div className="text-center space-y-5 animate-fade-in-up animate-fade-in-up-1">
        <h1 className="text-6xl font-bold tracking-tighter leading-none">
          Web Crawler
        </h1>
        <p className="text-lg text-muted-foreground max-w-md mx-auto leading-relaxed">
          Enter any URL. Get the complete source code with original file structure, ready to run locally.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 animate-fade-in-up animate-fade-in-up-2">
        <Link
          href="/crawl"
          className="btn-accent px-10 py-3.5 rounded-xl text-sm tracking-wide"
        >
          Start Crawling
        </Link>
        <span className="text-xs text-muted-foreground/50">
          BFS traversal &middot; Proxy caching &middot; ZIP download
        </span>
      </div>
    </div>
  );
}
