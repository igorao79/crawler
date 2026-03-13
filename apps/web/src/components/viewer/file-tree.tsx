"use client";

import { useState } from "react";
import { FileCode, FileText, Paintbrush, Sparkles, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SourceCategory } from "@/lib/api";
import { cn } from "@/lib/utils";

interface FileTreeProps {
  categories: SourceCategory[];
  selectedFile: { category: string; name: string } | null;
  onSelectFile: (category: string, name: string) => void;
}

const CATEGORY_ICONS: Record<string, typeof FileCode> = {
  js: FileCode,
  css: Paintbrush,
  html: FileText,
  shaders: Sparkles,
  "assets-index": FolderOpen,
};

const CATEGORY_LABELS: Record<string, string> = {
  js: "JavaScript",
  css: "CSS & Styles",
  html: "HTML Pages",
  shaders: "GLSL Shaders",
  "assets-index": "Asset Index",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileTree({ categories, selectedFile, onSelectFile }: FileTreeProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(categories.map((c) => c.name))
  );

  const toggleCategory = (name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Source Files
        </div>
        {categories.map((cat) => {
          const Icon = CATEGORY_ICONS[cat.name] ?? FolderOpen;
          const isExpanded = expandedCategories.has(cat.name);
          return (
            <div key={cat.name}>
              <button
                onClick={() => toggleCategory(cat.name)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent/50 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{CATEGORY_LABELS[cat.name] ?? cat.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{cat.files.length}</span>
              </button>
              {isExpanded && (
                <div className="ml-4 space-y-0.5">
                  {cat.files.map((file) => {
                    const isSelected =
                      selectedFile?.category === cat.name && selectedFile?.name === file.name;
                    return (
                      <button
                        key={file.name}
                        onClick={() => onSelectFile(cat.name, file.name)}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-accent/50 transition-colors text-left",
                          isSelected && "bg-accent text-accent-foreground"
                        )}
                      >
                        <span className="truncate flex-1 font-mono">{file.name}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatSize(file.sizeBytes)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {categories.length === 0 && (
          <div className="text-center text-muted-foreground text-xs py-8">
            No deobfuscated source available.
            <br />
            Run the deobfuscation script first.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
