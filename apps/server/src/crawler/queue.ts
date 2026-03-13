export interface QueueItem {
  url: string;
  depth: number;
  parentUrl: string | null;
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // Remove trailing slash
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    // Remove hash
    url.hash = '';
    // Sort search params for consistency
    url.searchParams.sort();
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export class CrawlQueue {
  private queue: QueueItem[] = [];
  private visited: Set<string> = new Set();
  private maxDepth: number;
  private allowedDomain: string;

  constructor(maxDepth: number = 5, allowedDomain: string = 'lusion.co') {
    this.maxDepth = maxDepth;
    this.allowedDomain = allowedDomain;
  }

  add(url: string, depth: number, parentUrl: string | null = null): boolean {
    const normalized = normalizeUrl(url);

    if (this.visited.has(normalized)) return false;
    if (depth > this.maxDepth) return false;
    if (!this.isAllowedDomain(normalized)) return false;

    this.visited.add(normalized);
    this.queue.push({ url: normalized, depth, parentUrl });
    return true;
  }

  next(): QueueItem | undefined {
    return this.queue.shift();
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  size(): number {
    return this.queue.length;
  }

  visitedCount(): number {
    return this.visited.size;
  }

  hasVisited(url: string): boolean {
    return this.visited.has(normalizeUrl(url));
  }

  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname === this.allowedDomain || parsed.hostname.endsWith(`.${this.allowedDomain}`);
    } catch {
      return false;
    }
  }
}
