"use client";

import { useEffect, useState, useRef } from "react";
import { Copy, Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setIsHighlighting(true);

    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const lang = language === "glsl" ? "glsl" : language;
        const supportedLangs = ["javascript", "typescript", "css", "html", "json", "markdown", "glsl"];
        const finalLang = supportedLangs.includes(lang) ? lang : "text";

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
  }, [code, language]);

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
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/50">
        <span className="text-xs text-muted-foreground font-mono truncate">
          {filename}
          <span className="ml-2 text-[10px] opacity-60">
            ({(code.length / 1024).toFixed(1)} KB)
          </span>
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
      <div className="flex-1 overflow-auto">
        {isHighlighting ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Highlighting...
          </div>
        ) : highlightedHtml ? (
          <div
            ref={codeRef}
            className="text-xs [&_pre]:p-4 [&_pre]:m-0 [&_pre]:bg-transparent [&_code]:text-xs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-all">
            {code}
          </pre>
        )}
      </div>
    </div>
  );
}
