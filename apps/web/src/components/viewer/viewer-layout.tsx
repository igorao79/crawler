"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Monitor, Code, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PreviewPanel } from "./preview-panel";
import { CodePanel } from "./code-panel";
import { cn } from "@/lib/utils";

interface ViewerLayoutProps {
  slug: string;
  proxyUrl?: string;
}

export function ViewerLayout({ slug, proxyUrl = "http://localhost:3002" }: ViewerLayoutProps) {
  const [leftWidthPercent, setLeftWidthPercent] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [mobileView, setMobileView] = useState<"preview" | "code">("preview");
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.min(80, Math.max(20, (x / rect.width) * 100));
      setLeftWidthPercent(percent);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div className="flex flex-col h-full">
      {/* Mobile toggle */}
      <div className="flex md:hidden border-b border-border">
        <Button
          variant={mobileView === "preview" ? "default" : "ghost"}
          className="flex-1 rounded-none"
          onClick={() => setMobileView("preview")}
        >
          <Monitor className="h-4 w-4 mr-2" />
          Preview
        </Button>
        <Button
          variant={mobileView === "code" ? "default" : "ghost"}
          className="flex-1 rounded-none"
          onClick={() => setMobileView("code")}
        >
          <Code className="h-4 w-4 mr-2" />
          Code
        </Button>
      </div>

      {/* Desktop split view */}
      <div
        ref={containerRef}
        className="flex-1 hidden md:flex relative"
        style={{ cursor: isDragging ? "col-resize" : undefined }}
      >
        {/* Left panel — Preview */}
        <div
          className="h-full overflow-hidden"
          style={{ width: `${leftWidthPercent}%` }}
        >
          <PreviewPanel slug={slug} proxyUrl={proxyUrl} />
        </div>

        {/* Drag handle */}
        <div
          className={cn(
            "w-1 bg-border hover:bg-primary/50 cursor-col-resize flex items-center justify-center shrink-0 transition-colors",
            isDragging && "bg-primary"
          )}
          onMouseDown={handleMouseDown}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>

        {/* Right panel — Code */}
        <div
          className="h-full overflow-hidden"
          style={{ width: `${100 - leftWidthPercent}%` }}
        >
          <CodePanel />
        </div>
      </div>

      {/* Mobile single view */}
      <div className="flex-1 md:hidden">
        {mobileView === "preview" ? (
          <PreviewPanel slug={slug} proxyUrl={proxyUrl} />
        ) : (
          <CodePanel />
        )}
      </div>
    </div>
  );
}
