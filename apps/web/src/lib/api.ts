const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Proxy is integrated into the main server — same URL
export const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL ?? API_BASE;

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { method = 'GET', body } = options;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorData: unknown = await res.json().catch(() => null);
    const message =
      errorData && typeof errorData === 'object' && 'message' in errorData
        ? String((errorData as { message: string }).message)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

// ===== Crawl API =====

interface CrawlJobResponse {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalPages: number;
  parsedPages: number;
  maxDepth: number;
  error: string | null;
}

interface CreateCrawlResponse {
  id: string;
  status: string;
}

export function startCrawl(url: string, maxDepth: number): Promise<CreateCrawlResponse> {
  return apiFetch('/api/crawl', { method: 'POST', body: { url, maxDepth } });
}

export function getCrawlStatus(id: string): Promise<CrawlJobResponse> {
  return apiFetch(`/api/crawl/${id}`);
}

export function cancelCrawl(id: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/api/crawl/${id}`, { method: 'DELETE' });
}

// ===== Projects API =====

interface ProjectListItem {
  id: string;
  slug: string;
  url: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAt: string | null;
}

interface PaginatedProjects {
  data: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface AssetItem {
  id: string;
  projectId: string | null;
  url: string;
  type: string;
  filePath: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

interface PageItem {
  id: string;
  crawlJobId: string | null;
  projectId: string | null;
  url: string;
  depth: number;
  parentUrl: string | null;
  fullHtml: string | null;
  title: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface ProjectDetail {
  id: string;
  crawlJobId: string | null;
  slug: string;
  url: string;
  title: string | null;
  description: string | null;
  tags: string[];
  fullHtml: string | null;
  scripts: string[];
  stylesheets: string[];
  createdAt: string | null;
  assets: AssetItem[];
  pages: PageItem[];
}

export function getProjects(params?: {
  page?: number;
  pageSize?: number;
  tag?: string;
  search?: string;
}): Promise<PaginatedProjects> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.tag) searchParams.set('tag', params.tag);
  if (params?.search) searchParams.set('search', params.search);

  const qs = searchParams.toString();
  return apiFetch(`/api/projects${qs ? `?${qs}` : ''}`);
}

export function getProject(slug: string): Promise<ProjectDetail> {
  return apiFetch(`/api/projects/${slug}`);
}

// ===== Source API =====

export interface SourceFile {
  name: string;
  displayName: string;
  sizeBytes: number;
}

export interface SourceCategory {
  name: string;
  files: SourceFile[];
}

export interface SourceTree {
  categories: SourceCategory[];
}

export function getSourceTree(): Promise<SourceTree> {
  return apiFetch('/api/source/tree');
}

export async function getSourceFile(category: string, name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/source/file?category=${encodeURIComponent(category)}&name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to load file: HTTP ${res.status}`);
  return res.text();
}

// ===== Assets API =====

export interface AssetIndexItem {
  path: string;
  ext: string;
}

export interface AssetIndexCategory {
  name: string;
  count: number;
  items: AssetIndexItem[];
}

export interface AssetIndex {
  categories: AssetIndexCategory[];
  total: number;
}

export function getAssetIndex(): Promise<AssetIndex> {
  return apiFetch('/api/source/assets');
}

// ===== AI Deobfuscation API =====

export interface DeobfuscateProgress {
  totalChunks: number;
  currentChunk: number;
  fileName: string;
  status: 'processing' | 'done' | 'error';
  message?: string;
}

/**
 * Start AI deobfuscation of a JS file.
 * Streams newline-delimited JSON progress events.
 */
export async function startDeobfuscation(
  fileName: string,
  onProgress: (progress: DeobfuscateProgress) => void,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/source/deobfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });

  if (!res.ok) {
    const errorData: unknown = await res.json().catch(() => null);
    const message =
      errorData && typeof errorData === 'object' && 'message' in errorData
        ? String((errorData as { message: string }).message)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const progress = JSON.parse(line) as DeobfuscateProgress;
          onProgress(progress);
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const progress = JSON.parse(buffer) as DeobfuscateProgress;
      onProgress(progress);
    } catch {
      // skip
    }
  }
}

export { type CrawlJobResponse, type ProjectListItem, type PaginatedProjects, type AssetItem, type PageItem };
