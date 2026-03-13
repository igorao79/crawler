import { chromium, Browser, Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { CrawlQueue } from './queue.js';
import { extractPageData, type ExtractedData } from './extractor.js';
import { collectAssets, deduplicateAssets, classifyAssetUrl } from './asset-collector.js';
import type { DrizzleDB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { CrawlProgress, CrawlStatus } from '@lusion-crawler/shared';

const LUSION_BASE = 'https://lusion.co';
const DELAY_MS = 1500; // Delay between requests to be polite
const PAGE_TIMEOUT = 60000;
const MAX_RETRIES = 3;
const JS_RENDER_WAIT = 8000; // Extra wait for JS/WebGL rendering
const OUTPUT_DIR = './output';

export type ProgressCallback = (progress: CrawlProgress) => void;

export class Crawler {
  private db: DrizzleDB;
  private jobId: string;
  private maxDepth: number;
  private maxPages: number;
  private onProgress: ProgressCallback | null;
  private browser: Browser | null = null;
  private aborted = false;

  constructor(
    db: DrizzleDB,
    jobId: string,
    maxDepth: number = 5,
    onProgress: ProgressCallback | null = null,
    maxPages: number = 0, // 0 = unlimited
  ) {
    this.db = db;
    this.jobId = jobId;
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
      const queue = new CrawlQueue(this.maxDepth, 'lusion.co');

      // Step 1: Collect project URLs from /projects page
      this.emitProgress(0, 0, 'Collecting project URLs from lusion.co/projects...', 'running');
      const projectUrls = await this.collectProjectUrls();
      console.log(`[Crawler] Found ${projectUrls.length} project URLs`);

      // Update total pages
      await this.db
        .update(schema.crawlJobs)
        .set({ totalPages: projectUrls.length })
        .where(eq(schema.crawlJobs.id, this.jobId));

      // Add project URLs to queue (limit if maxPages set)
      const urlsToAdd = this.maxPages > 0 ? projectUrls.slice(0, this.maxPages) : projectUrls;
      for (const url of urlsToAdd) {
        queue.add(url, 1);
      }

      // Step 2: Parse each project (BFS)
      let parsedCount = 0;

      while (!queue.isEmpty() && !this.aborted) {
        const item = queue.next();
        if (!item) break;

        try {
          const parsed = await this.parsePage(item.url);
          const { data, networkAssets, screenshot, mhtml } = parsed;
          const slug = this.extractSlug(item.url);

          if (item.depth === 1 && slug) {
            // It's a project page
            const projectId = uuidv4();
            await this.saveProject(projectId, slug, item.url, data);
            await this.saveAssets(projectId, data, networkAssets);
            // Download all assets + screenshot + MHTML to local folder
            await this.downloadProjectAssets(slug, data, networkAssets, screenshot, mhtml);
          } else {
            // It's a sub-page
            await this.savePage(item.url, item.depth, item.parentUrl, data);
          }

          // Add internal links to queue (depth + 1)
          for (const link of data.internalLinks) {
            queue.add(link, item.depth + 1, item.url);
          }

          parsedCount++;
          await this.db
            .update(schema.crawlJobs)
            .set({
              parsedPages: parsedCount,
              totalPages: parsedCount + queue.size(),
            })
            .where(eq(schema.crawlJobs.id, this.jobId));

          this.emitProgress(parsedCount, parsedCount + queue.size(), item.url, 'running');
        } catch (err) {
          console.error(`Error parsing ${item.url}:`, err);
        }

        // Polite delay
        await this.delay(DELAY_MS);
      }

      await this.updateJobStatus(this.aborted ? 'error' : 'done');
      this.emitProgress(parsedCount, parsedCount, '', this.aborted ? 'error' : 'done');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
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
      await page.goto(`${LUSION_BASE}/projects`, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
      // Wait for Cloudflare challenge to pass + page render
      await this.delay(5000);

      const urls = await page.evaluate((base: string): string[] => {
        const links = document.querySelectorAll('a[href]');
        const projectUrls: string[] = [];
        links.forEach((link) => {
          const href = link.getAttribute('href');
          if (href && href.startsWith('/projects/') && href !== '/projects/') {
            try {
              projectUrls.push(new URL(href, base).href);
            } catch {
              // skip
            }
          }
        });
        return [...new Set(projectUrls)];
      }, LUSION_BASE);

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
        await page.goto(url, {
          waitUntil: 'load',
          timeout: PAGE_TIMEOUT,
        });
        // Wait extra time for JS to render (WebGL, 3D, dynamic content)
        await this.delay(JS_RENDER_WAIT);

        const data = await extractPageData(page, url);

        // Take full-page screenshot of the rendered page
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });

        // Save MHTML snapshot via CDP (captures rendered page with all inline resources)
        let mhtml: string | null = null;
        try {
          const cdp = await page.context().newCDPSession(page);
          const { data: mhtmlData } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
          mhtml = mhtmlData;
          await cdp.detach();
        } catch (err) {
          console.warn(`[Crawler] MHTML capture failed for ${url}:`, err instanceof Error ? err.message : err);
        }

        return { data, networkAssets, screenshot, mhtml };
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

  private async downloadProjectAssets(
    slug: string,
    data: ExtractedData,
    networkAssets: NetworkAsset[],
    screenshot: Buffer,
    mhtml: string | null,
  ): Promise<void> {
    const projectDir = join(OUTPUT_DIR, slug);
    const assetsDir = join(projectDir, 'assets');
    const cssDir = join(projectDir, 'css');
    const jsDir = join(projectDir, 'js');

    // Create directories
    for (const dir of [projectDir, assetsDir, cssDir, jsDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    // Save screenshot (this is the actual rendered page!)
    writeFileSync(join(projectDir, 'screenshot.png'), screenshot);
    console.log(`[Crawler] Saved screenshot for ${slug} (${(screenshot.length / 1024).toFixed(0)} KB)`);

    // Save MHTML snapshot (can be opened in Chrome to see the full rendered page)
    if (mhtml) {
      writeFileSync(join(projectDir, 'snapshot.mhtml'), mhtml, 'utf-8');
      console.log(`[Crawler] Saved MHTML snapshot for ${slug}`);
    }

    // Collect all asset URLs
    const allAssetUrls = new Set<string>([
      ...data.stylesheets,
      ...data.scripts,
      ...data.imageUrls,
      ...data.videoUrls,
      ...data.model3dUrls,
      ...networkAssets.map((a) => a.url),
    ]);

    // Download all assets and build URL -> local path map
    const urlToLocalPath = new Map<string, string>();
    let downloaded = 0;
    let failed = 0;

    for (const url of allAssetUrls) {
      try {
        const type = classifyAssetUrl(url);
        let targetSubdir = 'assets';
        let targetDir = assetsDir;
        if (type === 'stylesheet') { targetDir = cssDir; targetSubdir = 'css'; }
        else if (type === 'script') { targetDir = jsDir; targetSubdir = 'js'; }

        const filename = sanitizeFilename(url);
        const filePath = join(targetDir, filename);
        const relativePath = `${targetSubdir}/${filename}`;

        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          failed++;
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filePath, buffer);
        urlToLocalPath.set(url, relativePath);

        // Update asset record with file path
        await this.db
          .update(schema.assets)
          .set({ filePath, sizeBytes: buffer.length })
          .where(eq(schema.assets.url, url));

        downloaded++;
      } catch {
        failed++;
      }
    }

    // Rewrite HTML: replace absolute/remote URLs with local relative paths
    let localHtml = data.fullHtml;

    // Remove <base href="/"> — it breaks relative paths when served locally
    localHtml = localHtml.replace(/<base\s+href="[^"]*"\s*\/?>/gi, '');

    for (const [originalUrl, localPath] of urlToLocalPath) {
      // Replace full URLs (https://lusion.co/...)
      localHtml = localHtml.split(originalUrl).join(localPath);

      // Also replace path-only references (/_astro/..., /assets/...)
      try {
        const parsed = new URL(originalUrl);
        if (parsed.hostname.includes('lusion.co')) {
          localHtml = localHtml.split(parsed.pathname).join(localPath);
        }
      } catch {
        // skip
      }
    }

    // Replace any remaining absolute paths to lusion.co with relative
    localHtml = localHtml.replace(/https?:\/\/lusion\.co\//g, '');

    // Save rewritten HTML
    writeFileSync(join(projectDir, 'index.html'), localHtml, 'utf-8');

    // Save original HTML too
    writeFileSync(join(projectDir, 'original.html'), data.fullHtml, 'utf-8');

    // Save metadata
    const metadata = {
      title: data.title,
      description: data.description,
      tags: data.tags,
      scripts: data.scripts,
      stylesheets: data.stylesheets,
      imageUrls: data.imageUrls,
      videoUrls: data.videoUrls,
      model3dUrls: data.model3dUrls,
      networkAssetsCount: networkAssets.length,
      downloadedAssets: downloaded,
      failedAssets: failed,
      urlMap: Object.fromEntries(urlToLocalPath),
    };
    writeFileSync(join(projectDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

    console.log(`[Crawler] Downloaded ${downloaded} assets for ${slug} (${failed} failed)`);
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
      const match = pathname.match(/\/projects\/([^/]+)/);
      return match ? match[1] : null;
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
  screenshot: Buffer;
  mhtml: string | null;
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

function sanitizeFilename(url: string): string {
  try {
    const parsed = new URL(url);
    let name = basename(parsed.pathname);
    // Add hash of full URL to avoid collisions
    const hash = Buffer.from(url).toString('base64url').slice(-8);
    if (!name || name === '/') {
      name = hash;
    } else {
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        name = name.slice(0, dotIdx) + '_' + hash + name.slice(dotIdx);
      } else {
        name = name + '_' + hash;
      }
    }
    // Remove dangerous chars
    return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 200);
  } catch {
    return Buffer.from(url).toString('base64url').slice(0, 50);
  }
}
