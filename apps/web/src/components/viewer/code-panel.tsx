"use client";

import { useState, useEffect } from "react";
import { FileTree } from "./file-tree";
import { CodeBlock, inferLanguage } from "./code-block";
import { getSourceTree, getSourceFile, type SourceCategory } from "@/lib/api";

export function CodePanel() {
  const [categories, setCategories] = useState<SourceCategory[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ category: string; name: string } | null>(null);
  const [code, setCode] = useState<string>("");
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);

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
      <div className="flex-1 min-w-0">
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
  );
}
