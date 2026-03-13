"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getProjects, type ProjectListItem } from "@/lib/api";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 12;

  useEffect(() => {
    setLoading(true);
    getProjects({
      page,
      pageSize,
      tag: activeTag ?? undefined,
      search: search || undefined,
    })
      .then((res) => {
        setProjects(res.data);
        setTotal(res.total);
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [page, search, activeTag]);

  // Collect all unique tags
  const allTags = [...new Set(projects.flatMap((p) => p.tags))];
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <span className="text-sm text-muted-foreground">{total} total</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search projects..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-64"
        />
        <div className="flex gap-1 flex-wrap">
          {activeTag && (
            <Badge
              variant="default"
              className="cursor-pointer"
              onClick={() => {
                setActiveTag(null);
                setPage(1);
              }}
            >
              {activeTag} x
            </Badge>
          )}
          {allTags
            .filter((t) => t !== activeTag)
            .map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => {
                  setActiveTag(tag);
                  setPage(1);
                }}
              >
                {tag}
              </Badge>
            ))}
        </div>
      </div>

      {/* Project Grid */}
      {loading ? (
        <div className="text-center text-muted-foreground py-12">Loading...</div>
      ) : projects.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          No projects found. Run a crawl first.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.slug}`}>
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {project.title ?? project.slug}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {project.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {project.description}
                    </p>
                  )}
                  <div className="flex gap-1 flex-wrap">
                    {project.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {project.url}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
