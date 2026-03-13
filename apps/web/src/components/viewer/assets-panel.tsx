"use client";

import { useEffect, useState } from "react";
import {
  Box, ImageIcon, Video, Music, Type, Download, ChevronDown, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAssetIndex, PROXY_URL, type AssetIndexCategory } from "@/lib/api";

const categoryIcons: Record<string, typeof Box> = {
  "3D Models": Box,
  "Images": ImageIcon,
  "Videos": Video,
  "Audio": Music,
  "Fonts": Type,
};

const categoryColors: Record<string, string> = {
  "3D Models": "#c1ff00",
  "Images": "#00d4ff",
  "Videos": "#ff4c41",
  "Audio": "#8832f7",
  "Fonts": "#1a2ffb",
};

export function AssetsPanel() {
  const [categories, setCategories] = useState<AssetIndexCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");

  useEffect(() => {
    getAssetIndex()
      .then((data) => {
        setCategories(data.categories);
        setTotal(data.total);
        // Expand first category by default
        if (data.categories.length > 0) {
          setExpanded({ [data.categories[0].name]: true });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleCategory = (name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="w-6 h-6 border-2 border-[#c1ff00]/30 border-t-[#c1ff00] rounded-full animate-spin" />
        <span className="text-muted-foreground text-sm">Loading assets...</span>
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No assets found. Run deobfuscation first.
      </div>
    );
  }

  const filtered = search
    ? categories.map((cat) => ({
        ...cat,
        items: cat.items.filter((item) =>
          item.path.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter((cat) => cat.items.length > 0)
    : categories;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.08] bg-background/80 backdrop-blur-md shrink-0">
        <span className="text-xs text-muted-foreground">
          <span className="text-foreground font-semibold">{total}</span> assets found
        </span>
        <input
          placeholder="Search assets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48 h-7 px-3 rounded-md text-xs bg-white/[0.04] border border-white/[0.08] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#c1ff00]/30 transition-all"
        />
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-auto">
        {filtered.map((cat) => {
          const Icon = categoryIcons[cat.name] || Box;
          const color = categoryColors[cat.name] || "#c1ff00";
          const isExpanded = expanded[cat.name];

          return (
            <div key={cat.name}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(cat.name)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors border-b border-white/[0.04]"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <Icon className="h-4 w-4 shrink-0" style={{ color }} />
                <span className="text-sm font-medium">{cat.name}</span>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full border ml-auto"
                  style={{
                    color,
                    borderColor: `${color}40`,
                    backgroundColor: `${color}15`,
                  }}
                >
                  {search ? cat.items.length : cat.count}
                </span>
              </button>

              {/* Items */}
              {isExpanded && (
                <div className="bg-white/[0.01]">
                  {cat.items.map((item) => {
                    const filename = item.path.split("/").pop() || item.path;
                    const dir = item.path.split("/").slice(0, -1).join("/");
                    const assetUrl = `${PROXY_URL}/${item.path}`;

                    return (
                      <div
                        key={item.path}
                        className="flex items-center gap-3 px-4 py-2 pl-11 hover:bg-white/[0.03] transition-colors group border-b border-white/[0.02]"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-mono text-foreground/80 truncate">
                            {filename}
                          </p>
                          <p className="text-[10px] text-muted-foreground/50 truncate">
                            {dir}
                          </p>
                        </div>
                        <span className="text-[10px] text-muted-foreground/40 font-mono uppercase shrink-0">
                          .{item.ext}
                        </span>
                        <a
                          href={assetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Button variant="ghost" size="sm" className="h-6 px-1.5">
                            <Download className="h-3 w-3" />
                          </Button>
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
