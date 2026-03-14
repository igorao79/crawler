"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileTree } from "./file-tree";
import { CodeBlock, inferLanguage } from "./code-block";
import {
  getSourceTree,
  getSourceFile,
  startDeobfuscation,
  type SourceCategory,
  type DeobfuscateProgress,
} from "@/lib/api";

export function CodePanel() {
  const [categories, setCategories] = useState<SourceCategory[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ category: string; name: string } | null>(null);
  const [code, setCode] = useState<string>("");
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [deobfuscating, setDeobfuscating] = useState(false);
  const [deobfuscateProgress, setDeobfuscateProgress] = useState<DeobfuscateProgress | null>(null);

  // Load file tree
  useEffect(() => {
    getSourceTree()
      .then((tree) => {
        setCategories(tree.categories);
        // Auto-select first file
        if (tree.categories.length > 0 && tree.categories[0].files.length > 0) {
          const cat = tree.categories[0];
          setSelectedFile({ category: cat.name, name: cat.files[0].name });
        }
      })
      .catch(() => setCategories([]))
      .finally(() => setLoadingTree(false));
  }, []);

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedFile) return;
    setLoadingFile(true);
    getSourceFile(selectedFile.category, selectedFile.name)
      .then(setCode)
      .catch(() => setCode("// Failed to load file"))
      .finally(() => setLoadingFile(false));
  }, [selectedFile]);

  const handleSelectFile = (category: string, name: string) => {
    setSelectedFile({ category, name });
  };

  const handleAiDeobfuscate = useCallback(async () => {
    if (!selectedFile || deobfuscating) return;
    // Only works on JS files
    if (selectedFile.category !== 'js') return;

    setDeobfuscating(true);
    setDeobfuscateProgress(null);

    try {
      await startDeobfuscation(selectedFile.name, (progress) => {
        setDeobfuscateProgress(progress);

        // When done, reload file tree and switch to the AI-deobfuscated version
        if (progress.status === 'done') {
          getSourceTree()
            .then((tree) => {
              setCategories(tree.categories);
              setSelectedFile({ category: 'ai-deobfuscated', name: selectedFile.name });
            })
            .catch(() => {});
        }
      });
    } catch (err) {
      setDeobfuscateProgress({
        totalChunks: 0,
        currentChunk: 0,
        fileName: selectedFile.name,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to start deobfuscation',
      });
    } finally {
      setDeobfuscating(false);
    }
  }, [selectedFile, deobfuscating]);

  if (loadingTree) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading source tree...
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* File tree sidebar */}
      <div className="w-56 border-r border-border shrink-0">
        <FileTree
          categories={categories}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
        />
      </div>

      {/* Code content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* AI Deobfuscate bar — only for JS files */}
        {selectedFile?.category === 'js' && (
          <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.08] bg-background/60">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAiDeobfuscate}
              disabled={deobfuscating}
              className="h-7 px-3 text-xs"
            >
              {deobfuscating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              {deobfuscating ? 'Deobfuscating...' : 'AI Deobfuscate'}
            </Button>
            {deobfuscateProgress && (
              <span className="text-xs text-muted-foreground">
                {deobfuscateProgress.status === 'processing' && (
                  <>Chunk {deobfuscateProgress.currentChunk}/{deobfuscateProgress.totalChunks}</>
                )}
                {deobfuscateProgress.status === 'done' && (
                  <span className="text-green-400">Done — view in ai-deobfuscated/</span>
                )}
                {deobfuscateProgress.status === 'error' && (
                  <span className="text-red-400">{deobfuscateProgress.message}</span>
                )}
              </span>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0">
          {selectedFile ? (
            loadingFile ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Loading file...
              </div>
            ) : (
              <CodeBlock
                code={code}
                filename={selectedFile.name}
                language={inferLanguage(selectedFile.name)}
              />
            )
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Select a file from the tree
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
