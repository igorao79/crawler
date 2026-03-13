"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Copy, Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// Max file size for Shiki highlighting (100KB). Larger files render as plain text.
const MAX_HIGHLIGHT_SIZE = 100 * 1024;
// Lines to render initially for large files
const INITIAL_LINES = 500;
const LOAD_MORE_LINES = 500;

interface CodeBlockProps {
  code: string;
  filename: string;
  language: string;
}

function inferLanguage(filename: string): string {
  if (filename.endsWith(".js") || filename.endsWith(".mjs")) return "javascript";
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return "typescript";
  if (filename.endsWith(".css")) return "css";
  if (filename.endsWith(".html")) return "html";
  if (filename.endsWith(".glsl") || filename.endsWith(".vert") || filename.endsWith(".frag")) return "glsl";
  if (filename.endsWith(".json")) return "json";
  if (filename.endsWith(".md")) return "markdown";
  return "text";
}

export { inferLanguage };

export function CodeBlock({ code, filename, language }: CodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");
  const [isHighlighting, setIsHighlighting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visibleLines, setVisibleLines] = useState(INITIAL_LINES);
  const codeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isLargeFile = code.length > MAX_HIGHLIGHT_SIZE;
  const allLines = code.split("\n");
  const totalLines = allLines.length;

  // Reset visible lines when file changes
  useEffect(() => {
    setVisibleLines(INITIAL_LINES);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [code]);

  // Shiki highlighting for small files only
  useEffect(() => {
    if (isLargeFile) {
      setHighlightedHtml("");
      setIsHighlighting(false);
      return;
    }

    let cancelled = false;
    setIsHighlighting(true);

    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const supportedLangs = ["javascript", "typescript", "css", "html", "json", "markdown", "glsl"];
        const finalLang = supportedLangs.includes(language) ? language : "text";

        const html = await codeToHtml(code, {
          lang: finalLang as "javascript",
          theme: "github-dark",
        });

        if (!cancelled) {
          setHighlightedHtml(html);
          setIsHighlighting(false);
        }
      } catch {
        if (!cancelled) {
          setHighlightedHtml("");
          setIsHighlighting(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code, language, isLargeFile]);

  // Infinite scroll for large files
  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !isLargeFile) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    if (scrollHeight - scrollTop - clientHeight < 200 && visibleLines < totalLines) {
      setVisibleLines((v) => Math.min(v + LOAD_MORE_LINES, totalLines));
    }
  }, [isLargeFile, visibleLines, totalLines]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="relative flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.08] bg-background/80 backdrop-blur-md">
        <span className="text-xs text-muted-foreground font-mono truncate">
          {filename}
          <span className="ml-2 text-[10px] opacity-60">
            ({(code.length / 1024).toFixed(1)} KB · {totalLines} lines)
          </span>
          {isLargeFile && (
            <span className="ml-2 text-[10px] text-yellow-400/70">
              Large file — plain text mode
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 px-2">
            {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="ml-1 text-xs">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDownload} className="h-7 px-2">
            <Download className="h-3.5 w-3.5" />
            <span className="ml-1 text-xs">Download</span>
          </Button>
        </div>
      </div>

      {/* Code content */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        {isHighlighting ? (
          <div className="flex flex-col items-center justify-center h-32 gap-3">
            <div className="w-6 h-6 border-2 border-[#c1ff00]/30 border-t-[#c1ff00] rounded-full animate-spin" />
            <span className="text-muted-foreground text-sm">Highlighting syntax...</span>
          </div>
        ) : highlightedHtml ? (
          <div
            ref={codeRef}
            className="text-xs [&_pre]:p-4 [&_pre]:m-0 [&_pre]:bg-transparent [&_code]:text-xs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          /* Plain text with line numbers — used for large files */
          <div className="flex text-xs font-mono">
            {/* Line numbers */}
            <div className="sticky left-0 shrink-0 py-4 pl-4 pr-3 text-right select-none text-muted-foreground/30 bg-background/80 border-r border-white/[0.04]">
              {allLines.slice(0, visibleLines).map((_, i) => (
                <div key={i} className="leading-5">{i + 1}</div>
              ))}
            </div>
            {/* Code */}
            <pre className="p-4 whitespace-pre-wrap break-all leading-5 text-foreground/80 min-w-0">
              {allLines.slice(0, visibleLines).join("\n")}
              {visibleLines < totalLines && (
                <div className="text-center text-muted-foreground/50 py-4">
                  Showing {visibleLines} of {totalLines} lines — scroll for more...
                </div>
              )}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
