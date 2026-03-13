"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { getProject, type ProjectDetail } from "@/lib/api";

export default function ProjectDetailPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    getProject(slug)
      .then(setProject)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return <div className="text-center text-muted-foreground py-12">Loading...</div>;
  }

  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">{error ?? "Project not found"}</p>
        <Link href="/projects" className="text-sm text-muted-foreground hover:underline mt-2 inline-block">
          Back to projects
        </Link>
      </div>
    );
  }

  const assetsByType = project.assets.reduce<Record<string, typeof project.assets>>((acc, asset) => {
    const type = asset.type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(asset);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/projects" className="text-sm text-muted-foreground hover:underline">
            &larr; Back to projects
          </Link>
          <h1 className="text-2xl font-bold mt-2">{project.title ?? project.slug}</h1>
          {project.description && (
            <p className="text-muted-foreground mt-1">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          <Link href={`/projects/${slug}/viewer`}>
            <Button size="sm">Open Viewer</Button>
          </Link>
        </div>
      </div>

      <Separator />

      {/* Tabs */}
      <Tabs defaultValue="meta">
        <TabsList>
          <TabsTrigger value="meta">Meta</TabsTrigger>
          <TabsTrigger value="assets">Assets ({project.assets.length})</TabsTrigger>
          <TabsTrigger value="pages">Pages ({project.pages.length})</TabsTrigger>
          <TabsTrigger value="html">HTML Preview</TabsTrigger>
        </TabsList>

        {/* Meta Tab */}
        <TabsContent value="meta" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Project Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">URL</span>
                <a href={project.url} target="_blank" rel="noopener noreferrer" className="hover:underline truncate">
                  {project.url}
                </a>
                <span className="text-muted-foreground">Slug</span>
                <span>{project.slug}</span>
                <span className="text-muted-foreground">Scripts</span>
                <span>{project.scripts.length}</span>
                <span className="text-muted-foreground">Stylesheets</span>
                <span>{project.stylesheets.length}</span>
                <span className="text-muted-foreground">Created</span>
                <span>{project.createdAt ?? "N/A"}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Assets Tab */}
        <TabsContent value="assets" className="space-y-4">
          {Object.entries(assetsByType).map(([type, typeAssets]) => (
            <Card key={type}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Badge>{type}</Badge>
                  <span className="text-sm font-normal text-muted-foreground">
                    {typeAssets.length} items
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="max-h-64">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>URL</TableHead>
                        <TableHead className="w-24">Size</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {typeAssets.map((asset) => (
                        <TableRow key={asset.id}>
                          <TableCell className="truncate max-w-md">
                            <a href={asset.url} target="_blank" rel="noopener noreferrer" className="text-xs hover:underline">
                              {asset.url}
                            </a>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {asset.sizeBytes ? `${(asset.sizeBytes / 1024).toFixed(1)} KB` : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          ))}
          {project.assets.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-8">No assets found</p>
          )}
        </TabsContent>

        {/* Pages Tab */}
        <TabsContent value="pages">
          <Card>
            <CardContent className="pt-6">
              {project.pages.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>URL</TableHead>
                      <TableHead className="w-20">Depth</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {project.pages.map((pg) => (
                      <TableRow key={pg.id}>
                        <TableCell className="truncate max-w-md text-xs">{pg.url}</TableCell>
                        <TableCell>{pg.depth}</TableCell>
                        <TableCell>
                          <Badge variant={pg.status === "parsed" ? "default" : "secondary"}>
                            {pg.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-8">
                  No sub-pages found
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* HTML Preview Tab */}
        <TabsContent value="html">
          <Card>
            <CardContent className="pt-6">
              {project.fullHtml ? (
                <ScrollArea className="h-[600px] rounded-md border">
                  <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-all">
                    {project.fullHtml.slice(0, 50000)}
                    {project.fullHtml.length > 50000 && "\n\n... (truncated)"}
                  </pre>
                </ScrollArea>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-8">
                  No HTML content available
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
