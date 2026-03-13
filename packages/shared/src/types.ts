// ===== Crawl Job =====

export type CrawlStatus = 'pending' | 'running' | 'done' | 'error';

export interface CrawlJob {
  id: string;
  status: CrawlStatus;
  startedAt: string | null;
  finishedAt: string | null;
  totalPages: number;
  parsedPages: number;
  maxDepth: number;
  error: string | null;
}

export interface CreateCrawlJobRequest {
  maxDepth?: number;
}

export interface CreateCrawlJobResponse {
  id: string;
  status: CrawlStatus;
}

// ===== Project =====

export interface Project {
  id: string;
  crawlJobId: string;
  slug: string;
  url: string;
  title: string | null;
  description: string | null;
  tags: string[];
  fullHtml: string | null;
  scripts: string[];
  stylesheets: string[];
  createdAt: string;
}

export interface ProjectListItem {
  id: string;
  slug: string;
  url: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAt: string;
}

export interface ProjectDetail extends Project {
  assets: Asset[];
  pages: PageInfo[];
}

// ===== Asset =====

export type AssetType = 'image' | 'video' | 'model3d' | 'font' | 'script' | 'stylesheet';

export interface Asset {
  id: string;
  projectId: string;
  url: string;
  type: AssetType;
  filePath: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

// ===== Page =====

export type PageStatus = 'pending' | 'parsed' | 'error';

export interface PageInfo {
  id: string;
  crawlJobId: string;
  projectId: string | null;
  url: string;
  depth: number;
  parentUrl: string | null;
  fullHtml: string | null;
  title: string | null;
  status: PageStatus;
  createdAt: string;
}

// ===== WebSocket Progress =====

export interface CrawlProgress {
  jobId: string;
  parsed: number;
  total: number;
  currentUrl: string;
  status: CrawlStatus;
}

// ===== API Responses =====

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: string;
  message: string;
}

// ===== Type Guards =====

export function isCrawlStatus(value: unknown): value is CrawlStatus {
  return typeof value === 'string' && ['pending', 'running', 'done', 'error'].includes(value);
}

export function isAssetType(value: unknown): value is AssetType {
  return (
    typeof value === 'string' &&
    ['image', 'video', 'model3d', 'font', 'script', 'stylesheet'].includes(value)
  );
}

export function isPageStatus(value: unknown): value is PageStatus {
  return typeof value === 'string' && ['pending', 'parsed', 'error'].includes(value);
}

export function isCreateCrawlJobRequest(value: unknown): value is CreateCrawlJobRequest {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.maxDepth !== undefined) {
    return typeof obj.maxDepth === 'number' && obj.maxDepth >= 1 && obj.maxDepth <= 5;
  }
  return true;
}
