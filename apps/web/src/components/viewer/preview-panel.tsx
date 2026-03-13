"use client";

import { useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PreviewPanelProps {
  slug: string;
  proxyUrl: string;
}

export function PreviewPanel({ slug, proxyUrl }: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const src = `${proxyUrl}/projects/${slug}`;

  const handleRefresh = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) {
      iframeRef.current.src = src;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/50">
        <span className="text-xs text-muted-foreground font-mono truncate">
          {src}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-7 px-2">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <a href={src} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost" size="sm" className="h-7 px-2">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </a>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 relative bg-black">
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm z-10">
            Loading 3D preview...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground text-sm z-10 gap-2">
            <p>Failed to load preview</p>
            <p className="text-xs">Make sure the proxy is running on {proxyUrl}</p>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
          onLoad={() => { setLoading(false); setError(false); }}
          onError={() => { setLoading(false); setError(true); }}
        />
      </div>
    </div>
  );
}
