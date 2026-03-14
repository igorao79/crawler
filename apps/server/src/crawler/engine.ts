import { chromium, Browser, Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { CrawlQueue } from './queue.js';
import { extractPageData, type ExtractedData } from './extractor.js';
import { collectAssets, deduplicateAssets, classifyAssetUrl } from './asset-collector.js';
import type { DrizzleDB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { CrawlProgress, CrawlStatus } from '@lusion-crawler/shared';

const DELAY_MS = 300; // Short delay between requests
const PAGE_TIMEOUT = 60000; // 60s for heavy SPA sites
const MAX_RETRIES = 2;
const JS_RENDER_WAIT = 3000; // Wait for JS rendering
const OUTPUT_DIR = './output';
const PROXY_URL = 'http://localhost:3001'; // Route through proxy for caching
const CONCURRENCY = 3; // Parse 3 pages in parallel

export type ProgressCallback = (progress: CrawlProgress) => void;

export class Crawler {
  private db: DrizzleDB;
  private jobId: string;
  private targetUrl: string;
  private targetHostname: string;
  private maxDepth: number;
  private maxPages: number;
  private onProgress: ProgressCallback | null;
  private browser: Browser | null = null;
  private aborted = false;

  constructor(
    db: DrizzleDB,
    jobId: string,
    targetUrl: string,
    maxDepth: number = 5,
    onProgress: ProgressCallback | null = null,
    maxPages: number = 0, // 0 = unlimited
  ) {
    this.db = db;
    this.jobId = jobId;
    // Normalize: ensure trailing slash stripped, no trailing path junk
    this.targetUrl = targetUrl.replace(/\/+$/, '');
    this.targetHostname = new URL(this.targetUrl).hostname;
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
    this.onProgress = onProgress;
  }

  async start(): Promise<void> {
    try {
      await this.updateJobStatus('running');
      this.emitProgress(0, 0, 'Launching browser...', 'running');

      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--no-sandbox',
        ],
      });
      const queue = new CrawlQueue(this.maxDepth, this.targetHostname);

      // Step 1: Collect internal URLs from the target site
      this.emitProgress(0, 0, `Collecting URLs from ${this.targetUrl}...`, 'running');
      let projectUrls: string[] = [];
      try {
        projectUrls = await this.collectProjectUrls();
      } catch (err) {
        console.warn(`[Crawler] collectProjectUrls failed, proceeding with target URL only:`, err);
      }
      console.log(`[Crawler] Found ${projectUrls.length} project URLs`);

      // Update total pages
      await this.db
        .update(schema.crawlJobs)
        .set({ totalPages: projectUrls.length })
        .where(eq(schema.crawlJobs.id, this.jobId));

      // Always add the target URL first
      queue.add(this.targetUrl, 0);

      // Add project URLs to queue (limit if maxPages set)
      const urlsToAdd = this.maxPages > 0 ? projectUrls.slice(0, this.maxPages) : projectUrls;
      for (const url of urlsToAdd) {
        queue.add(url, 1);
      }

      // Step 2: Parse pages in parallel (BFS)
      let parsedCount = 0;

      while (!queue.isEmpty() && !this.aborted) {
        // Grab up to CONCURRENCY items from the queue
        const batch: Array<{ url: string; depth: number; parentUrl: string | null }> = [];
        for (let i = 0; i < CONCURRENCY && !queue.isEmpty(); i++) {
          const item = queue.next();
          if (item) batch.push(item);
        }
        if (batch.length === 0) break;

        // Parse all pages in the batch concurrently
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const parsed = await this.parsePage(item.url);
            return { item, parsed };
          })
        );

        for (const result of results) {
          if (result.status === 'rejected') {
            console.error(`Error parsing page:`, result.reason);
            continue;
          }

          const { item, parsed } = result.value;
          const { data, networkAssets } = parsed;

          try {
            const slug = this.extractSlug(item.url);
            if (item.depth === 1 && slug) {
              const projectId = uuidv4();
              await this.saveProject(projectId, slug, item.url, data);
              await this.saveAssets(projectId, data, networkAssets);
            } else {
              await this.savePage(item.url, item.depth, item.parentUrl, data);
            }

            // Add internal links to queue (depth + 1)
            for (const link of data.internalLinks) {
              queue.add(link, item.depth + 1, item.url);
            }
          } catch (err) {
            console.error(`Error saving ${item.url}:`, err);
          }

          parsedCount++;
        }

        await this.db
          .update(schema.crawlJobs)
          .set({
            parsedPages: parsedCount,
            totalPages: parsedCount + queue.size(),
          })
          .where(eq(schema.crawlJobs.id, this.jobId));

        this.emitProgress(parsedCount, parsedCount + queue.size(), batch[batch.length - 1].url, 'running');

        // Short delay between batches
        if (!queue.isEmpty()) await this.delay(DELAY_MS);
      }

      await this.updateJobStatus(this.aborted ? 'error' : 'done');
      this.emitProgress(parsedCount, parsedCount, '', this.aborted ? 'error' : 'done');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emitProgress(0, 0, errorMessage, 'error');
      await this.db
        .update(schema.crawlJobs)
        .set({
          status: 'error',
          error: errorMessage,
          finishedAt: new Date().toISOString(),
        })
        .where(eq(schema.crawlJobs.id, this.jobId));
      throw err;
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  abort(): void {
    this.aborted = true;
  }

  private async collectProjectUrls(): Promise<string[]> {
    if (!this.browser) throw new Error('Browser not initialized');

    const page = await this.browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    // Hide webdriver detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    try {
      await page.goto(this.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
      // Wait for Cloudflare challenge to pass + page render
      await this.delay(5000);

      const targetHostname = this.targetHostname;
      const urls = await page.evaluate(({ base, hostname }): string[] => {
        const links = document.querySelectorAll('a[href]');
        const pageUrls: string[] = [];
        links.forEach((link) => {
          const href = link.getAttribute('href');
          if (!href) return;
          try {
            const resolved = new URL(href, base);
            if (resolved.hostname === hostname || resolved.hostname.endsWith('.' + hostname)) {
              pageUrls.push(resolved.href);
            }
          } catch {
            // skip
          }
        });
        return [...new Set(pageUrls)];
      }, { base: this.targetUrl, hostname: targetHostname });

      return urls;
    } finally {
      await page.close();
    }
  }

  private async parsePage(url: string): Promise<ParsedPage> {
    if (!this.browser) throw new Error('Browser not initialized');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const page = await this.browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const networkAssets: NetworkAsset[] = [];

      // Intercept all network responses to capture loaded resources
      page.on('response', (response) => {
        const resUrl = response.url();
        const contentType = response.headers()['content-type'] ?? '';
        const status = response.status();
        if (status >= 200 && status < 400 && isAssetUrl(resUrl, contentType)) {
          networkAssets.push({ url: resUrl, contentType, status });
        }
      });

      try {
        // Navigate through proxy so assets get cached with original structure
        const proxyPageUrl = url.replace(new URL(url).origin, PROXY_URL);
        await page.goto(proxyPageUrl, {
          waitUntil: 'load',
          timeout: PAGE_TIMEOUT,
        });
        // Wait for JS to render dynamic content
        await this.delay(JS_RENDER_WAIT);

        const data = await extractPageData(page, url);

        return { data, networkAssets };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`Retry ${attempt + 1}/${MAX_RETRIES} for ${url}: ${lastError.message}`);
      } finally {
        await page.close();
      }
    }

    throw lastError ?? new Error(`Failed to parse ${url}`);
  }

  private async saveProject(
    projectId: string,
    slug: string,
    url: string,
    data: ExtractedData,
  ): Promise<void> {
    await this.db.insert(schema.projects).values({
      id: projectId,
      crawlJobId: this.jobId,
      slug,
      url,
      title: data.title,
      description: data.description,
      tags: JSON.stringify(data.tags),
      fullHtml: data.fullHtml,
      scripts: JSON.stringify(data.scripts),
      stylesheets: JSON.stringify(data.stylesheets),
    });
  }

  private async saveAssets(projectId: string, data: ExtractedData, networkAssets: NetworkAsset[]): Promise<void> {
    const allUrls = [...data.imageUrls, ...data.videoUrls, ...data.model3dUrls];
    const collected = deduplicateAssets(collectAssets(allUrls));

    // Also add scripts and stylesheets as assets
    for (const scriptUrl of data.scripts) {
      collected.push({ url: scriptUrl, type: 'script' });
    }
    for (const cssUrl of data.stylesheets) {
      collected.push({ url: cssUrl, type: 'stylesheet' });
    }

    // Add network-intercepted assets not already in the list
    const existingUrls = new Set(collected.map((a) => a.url));
    for (const netAsset of networkAssets) {
      if (!existingUrls.has(netAsset.url)) {
        collected.push({ url: netAsset.url, type: classifyAssetUrl(netAsset.url) });
        existingUrls.add(netAsset.url);
      }
    }

    for (const asset of collected) {
      await this.db.insert(schema.assets).values({
        id: uuidv4(),
        projectId,
        url: asset.url,
        type: asset.type,
      });
    }

    console.log(`[Crawler] Saved ${collected.length} assets for project ${projectId}`);
  }


  private async savePage(
    url: string,
    depth: number,
    parentUrl: string | null,
    data: ExtractedData,
  ): Promise<void> {
    await this.db.insert(schema.pages).values({
      id: uuidv4(),
      crawlJobId: this.jobId,
      url,
      depth,
      parentUrl,
      fullHtml: data.fullHtml,
      title: data.title,
      status: 'parsed',
    });
  }

  private extractSlug(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      // Create slug from the URL path — strip leading/trailing slashes, replace slashes with dashes
      const cleaned = pathname.replace(/^\/+|\/+$/g, '');
      if (!cleaned) return null;
      return cleaned.replace(/\//g, '-');
    } catch {
      return null;
    }
  }

  private async updateJobStatus(status: CrawlStatus): Promise<void> {
    const now = new Date().toISOString();

    if (status === 'running') {
      await this.db
        .update(schema.crawlJobs)
        .set({ status, startedAt: now })
        .where(eq(schema.crawlJobs.id, this.jobId));
    } else if (status === 'done' || status === 'error') {
      await this.db
        .update(schema.crawlJobs)
        .set({ status, finishedAt: now })
        .where(eq(schema.crawlJobs.id, this.jobId));
    } else {
      await this.db
        .update(schema.crawlJobs)
        .set({ status })
        .where(eq(schema.crawlJobs.id, this.jobId));
    }
  }

  private emitProgress(parsed: number, total: number, currentUrl: string, status: CrawlStatus): void {
    if (this.onProgress) {
      this.onProgress({
        jobId: this.jobId,
        parsed,
        total,
        currentUrl,
        status,
      });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface ParsedPage {
  data: ExtractedData;
  networkAssets: NetworkAsset[];
}

interface NetworkAsset {
  url: string;
  contentType: string;
  status: number;
}

function isAssetUrl(url: string, contentType: string): boolean {
  const assetContentTypes = [
    'image/', 'video/', 'audio/', 'font/',
    'text/css', 'application/javascript', 'text/javascript',
    'model/', 'application/octet-stream',
  ];
  if (assetContentTypes.some((t) => contentType.startsWith(t))) return true;

  const assetExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico',
    '.mp4', '.webm', '.ogg', '.mov',
    '.glb', '.gltf', '.obj', '.fbx', '.usdz',
    '.woff', '.woff2', '.ttf', '.otf',
    '.css', '.js', '.mjs',
  ];
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return assetExtensions.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

