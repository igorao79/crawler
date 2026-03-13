"use client";

import { useState } from "react";
import { Monitor, Code, Image } from "lucide-react";
import { PreviewPanel } from "./preview-panel";
import { CodePanel } from "./code-panel";
import { PROXY_URL } from "@/lib/api";

interface ViewerLayoutProps {
  slug: string;
}

const tabs = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "code", label: "Source Code", icon: Code },
  { id: "assets", label: "Assets", icon: Image },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function ViewerLayout({ slug }: ViewerLayoutProps) {
  const proxyUrl = PROXY_URL;
  const [activeTab, setActiveTab] = useState<TabId>("preview");

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center border-b border-white/[0.08] bg-background/80 backdrop-blur-md shrink-0 px-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all relative
                ${isActive
                  ? "text-[#c1ff00]"
                  : "text-muted-foreground hover:text-foreground/80"
                }
              `}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-[#c1ff00] rounded-full shadow-[0_0_10px_rgba(193,255,0,0.5)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content — full height */}
      <div className="flex-1 min-h-0">
        {activeTab === "preview" && (
          <PreviewPanel slug={slug} proxyUrl={proxyUrl} />
        )}
        {activeTab === "code" && (
          <CodePanel />
        )}
        {activeTab === "assets" && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            <div className="text-center space-y-3">
              <Image className="h-10 w-10 mx-auto text-muted-foreground/40" />
              <p>Asset browser coming soon</p>
              <p className="text-xs text-muted-foreground/60">
                3D models, textures, fonts and more
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
