import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { setProxyCookies } from '../proxy/proxy-plugin.js';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { CrawlQueue } from './queue.js';
import { extractPageData, type ExtractedData } from './extractor.js';
import { collectAssets, deduplicateAssets, classifyAssetUrl } from './asset-collector.js';
import type { DrizzleDB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { CrawlProgress, CrawlStatus } from '@lusion-crawler/shared';

const DELAY_MS = 200; // Short delay between requests
const PAGE_TIMEOUT = 60000; // 60s for heavy SPA sites
const MAX_RETRIES = 2;
const JS_RENDER_WAIT = 1500; // Wait for JS rendering (reduced from 3s)
const OUTPUT_DIR = './output';
const PROXY_URL = 'http://localhost:3001'; // Route through proxy for caching
const CONCURRENCY = 5; // Parse 5 pages in parallel (was 3)

export type ProgressCallback = (progress: CrawlProgress) => void;

export class Crawler {
  private db: DrizzleDB;
  private jobId: string;
  private targetUrl: string;
  private targetHostname: string;
  private targetPathPrefix: string;
  private maxDepth: number;
  private maxPages: number;
  private onProgress: ProgressCallback | null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
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
    // Extract path prefix for scope limiting (e.g. /apps/mars2020 -> /apps/mars2020)
    const parsedPath = new URL(this.targetUrl).pathname.replace(/\/+$/, '');
    this.targetPathPrefix = parsedPath || '';
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
        channel: 'chrome', // Use system Chrome instead of bundled Chromium
        args: [
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-animations',
          '--disable-translate',
          '--no-first-run',
        ],
      });

      // Shared context for all pages — avoids expensive per-page context creation
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        serviceWorkers: 'block', // Block service workers — they slow down asset interception
      });
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // Block analytics/tracking requests at context level — saves network time on every page
      await this.context.route(/google-analytics\.com|googletagmanager\.com|facebook\.net|connect\.facebook\.com|doubleclick\.net|hotjar\.com|clarity\.ms/, route => route.abort());

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

            // Add internal links to queue (depth + 1), filtered by path scope
            for (const link of data.internalLinks) {
              try {
                const linkPath = new URL(link).pathname;
                if (!this.targetPathPrefix || linkPath.startsWith(this.targetPathPrefix)) {
                  queue.add(link, item.depth + 1, item.url);
                }
              } catch {
                queue.add(link, item.depth + 1, item.url);
              }
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

      // Post-crawl: download missing assets (DXT textures, webmanifest, favicons)
      await this.downloadMissingAssets();

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
      setProxyCookies(null);
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
    if (!this.context) throw new Error('Browser context not initialized');

    const page = await this.context.newPage();
    try {
      await page.goto(this.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
      // Smart wait: check for Cloudflare challenge, otherwise just wait for networkidle
      const hasChallengeFrame = await page.$('iframe[src*="challenges.cloudflare"], #challenge-running, .cf-browser-verification');
      if (hasChallengeFrame) {
        console.log('[Crawler] Cloudflare challenge detected, waiting...');
        await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      } else {
        // Quick networkidle wait instead of fixed 5s
        await Promise.race([
          page.waitForLoadState('networkidle').catch(() => {}),
          this.delay(3000),
        ]);
      }

      // Extract cookies from browser and pass to proxy for authenticated fetches
      const cookies = await page.context().cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      if (cookieStr) {
        setProxyCookies(cookieStr);
        console.log(`[Crawler] Forwarding ${cookies.length} cookies to proxy`);
      }

      const targetHostname = this.targetHostname;
      const pathPrefix = this.targetPathPrefix;
      const urls = await page.evaluate(({ base, hostname, prefix }): string[] => {
        const links = document.querySelectorAll('a[href]');
        const pageUrls: string[] = [];
        // Auth/app paths to skip
        const skipPaths = ['/signup', '/login', '/register', '/signin', '/auth', '/oauth', '/sso', '/account', '/dashboard', '/console'];
        links.forEach((link) => {
          const href = link.getAttribute('href');
          if (!href) return;
          try {
            const resolved = new URL(href, base);
            if (resolved.hostname !== hostname && !resolved.hostname.endsWith('.' + hostname)) return;
            // Skip auth/app paths
            const lowerPath = resolved.pathname.toLowerCase();
            if (skipPaths.some(sp => lowerPath === sp || lowerPath.startsWith(sp + '/'))) return;
            // Only include URLs under the same path prefix
            if (!prefix || resolved.pathname.startsWith(prefix)) {
              pageUrls.push(resolved.href);
            }
          } catch {
            // skip
          }
        });
        return [...new Set(pageUrls)];
      }, { base: this.targetUrl, hostname: targetHostname, prefix: pathPrefix });

      return urls;
    } finally {
      await page.close();
    }
  }

  private async parsePage(url: string): Promise<ParsedPage> {
    if (!this.context) throw new Error('Browser context not initialized');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const page = await this.context.newPage();
      const networkAssets: NetworkAsset[] = [];
      const cacheDir = join('./proxy-cache', this.targetHostname);
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

      // Intercept network responses — cache assets from external domains (e.g. lusion.dev for lusion.co)
      // Assets from the target domain are already cached by the proxy
      const skipDomains = ['google-analytics.com', 'googletagmanager.com', 'cloudflare.com', 'facebook.net', 'twitter.com', 'doubleclick.net', 'google.com', 'gstatic.com', 'googleapis.com', 'vimeo.com', 'vimeocdn.com', 'twimg.com'];
      page.on('response', async (response) => {
        const resUrl = response.url();
        const contentType = response.headers()['content-type'] ?? '';
        const status = response.status();
        if (status >= 200 && status < 400) {
          try {
            const parsed = new URL(resUrl);
            const hostname = parsed.hostname;
            const isTargetDomain = hostname === this.targetHostname || hostname.endsWith('.' + this.targetHostname);
            const isAsset = isAssetUrl(resUrl, contentType);
            const isSkipped = skipDomains.some(d => hostname.endsWith(d));

            // Cache external domain assets into the same cache dir (same pathname)
            // Proxy already handles target domain caching
            if (!isTargetDomain && isAsset && !isSkipped) {
              let safePath = parsed.pathname.replace(/[?#].*$/, '');
              if (safePath.endsWith('/') || safePath === '') safePath += 'index.html';
              const lastSeg = safePath.split('/').pop() || '';
              if (!lastSeg.includes('.')) safePath += '/index.html';
              const cachePath = join(cacheDir, safePath);
              const cacheFileDir = dirname(cachePath);
              if (!existsSync(cacheFileDir)) mkdirSync(cacheFileDir, { recursive: true });
              const body = await response.body().catch(() => null);
              if (body && !existsSync(cachePath)) {
                writeFileSync(cachePath, body);
                const meta = { contentType, status, url: resUrl, hostname, cachedAt: new Date().toISOString() };
                writeFileSync(cachePath + '.meta.json', JSON.stringify(meta, null, 2));
              }
            }
          } catch { /* ignore cache errors */ }

          if (isAssetUrl(resUrl, contentType)) {
            networkAssets.push({ url: resUrl, contentType, status });
          }
        }
      });

      try {
        // Navigate through proxy so all relative assets get cached automatically
        const proxyPageUrl = url.replace(new URL(url).origin, PROXY_URL);
        await page.goto(proxyPageUrl, {
          waitUntil: 'load',
          timeout: PAGE_TIMEOUT,
        });
        // Wait for JS to render dynamic content
        await this.delay(JS_RENDER_WAIT);

        // Run auto-scroll and click interactions with a hard 8s cap total
        await Promise.race([
          (async () => {
            await this.autoScroll(page);
            await this.clickInteractiveElements(page);
          })(),
          this.delay(8000),
        ]);

        // Wait for network to settle, but cap at 3 seconds
        await Promise.race([
          page.waitForLoadState('networkidle').catch(() => {}),
          this.delay(3000),
        ]);

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

  /** Scroll page to bottom to trigger lazy-loaded content */
  private async autoScroll(page: Page): Promise<void> {
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 800;
          const maxScrolls = 20; // Cap scrolls to keep it fast
          let scrolls = 0;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            scrolls++;
            if (totalHeight >= scrollHeight || scrolls >= maxScrolls) {
              // Scroll back to top
              window.scrollTo(0, 0);
              clearInterval(timer);
              resolve();
            }
          }, 80);
        });
      });
      // Brief wait for lazy-loaded content
      await this.delay(500);
    } catch { /* ignore scroll errors */ }
  }

  /** Click interactive elements (arrows, tabs, sliders, carousels) to trigger dynamic content loading */
  private async clickInteractiveElements(page: Page): Promise<void> {
    try {
      // Find and click navigation/interactive elements
      const clicked = await page.evaluate(async () => {
        // Selectors for common interactive elements that load new content
        const selectors = [
          // Arrows / navigation
          '[class*="arrow"]', '[class*="Arrow"]',
          '[class*="next"]', '[class*="Next"]',
          '[class*="prev"]', '[class*="Prev"]',
          '[class*="slider"] button', '[class*="Slider"] button',
          '[class*="carousel"] button', '[class*="Carousel"] button',
          '[class*="swiper"] button', '[class*="Swiper"] button',
          '[class*="gallery"] button', '[class*="Gallery"] button',
          // Tab navigation
          '[role="tab"]',
          '[class*="tab-"]', '[class*="Tab"]',
          // Generic navigation buttons
          'button[class*="nav"]', 'button[class*="Nav"]',
          // Pagination dots
          '[class*="dot"]', '[class*="pagination"] button',
          '[class*="bullet"]',
          // Common specific selectors
          '.slick-next', '.slick-prev',
          '.owl-next', '.owl-prev',
          '.splide__arrow',
        ];

        let clickCount = 0;
        const clicked = new Set<Element>();

        for (const selector of selectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (clicked.has(el)) continue;
              if (!(el instanceof HTMLElement)) continue;
              // Only click visible elements
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;

              clicked.add(el);
              el.click();
              clickCount++;
              // Small delay between clicks
              await new Promise(r => setTimeout(r, 100));

              if (clickCount >= 15) break; // Cap at 15 clicks
            }
          } catch { /* ignore */ }
          if (clickCount >= 15) break;
        }

        // Click "next" arrows multiple times to cycle through carousels
        const nextSelectors = [
          '[class*="next"]', '[class*="Next"]',
          '.slick-next', '.owl-next',
          '[class*="arrow-right"]', '[class*="ArrowRight"]',
          '[class*="arrow"][class*="right"]',
        ];
        for (const selector of nextSelectors) {
          try {
            const nextBtn = document.querySelector(selector);
            if (nextBtn && nextBtn instanceof HTMLElement) {
              const rect = nextBtn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                for (let i = 0; i < 5; i++) {
                  nextBtn.click();
                  await new Promise(r => setTimeout(r, 200));
                  clickCount++;
                }
              }
            }
          } catch { /* ignore */ }
        }

        return clickCount;
      });

      if (clicked > 0) {
        console.log(`[Crawler] Clicked ${clicked} interactive elements to trigger content loading`);
        // Wait for content triggered by clicks to load
        await this.delay(500);
      }
    } catch { /* ignore interaction errors */ }
  }

  /**
   * Post-crawl: download missing assets that the headless browser didn't fetch.
   * 1. DXT textures (headless uses ASTC, desktop browsers need DXT)
   * 2. Common files browsers request but don't trigger response events for (webmanifest, favicons)
   */
  private async downloadMissingAssets(): Promise<void> {
    const cacheDir = join('./proxy-cache', this.targetHostname);
    if (!existsSync(cacheDir)) return;
    if (!this.browser) return;

    const context = this.context || this.browser.contexts()[0] || await this.browser.newContext();
    let downloaded = 0;

    // Collect external asset domains from cached meta files
    const extDomains = new Set<string>();
    const findDomains = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fp = join(dir, entry.name);
        if (entry.isDirectory()) findDomains(fp);
        else if (entry.name.endsWith('.meta.json')) {
          try {
            const meta = JSON.parse(readFileSync(fp, 'utf-8'));
            if (meta.url) {
              const h = new URL(meta.url).hostname;
              if (h !== this.targetHostname && !h.endsWith('.' + this.targetHostname)) extDomains.add(h);
            }
          } catch {}
        }
      }
    };
    findDomains(cacheDir);
    if (extDomains.size > 0) {
      console.log(`[Crawler] Found external asset domains: ${[...extDomains].join(', ')}`);
    }

    // 1. Download DXT alternates for ASTC textures
    const astcFiles: string[] = [];
    const findAstc = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) findAstc(fullPath);
        else if (entry.name.endsWith('-astc.ktx')) astcFiles.push(fullPath);
      }
    };
    findAstc(cacheDir);

    if (astcFiles.length > 0) {
      console.log(`[Crawler] Found ${astcFiles.length} ASTC textures, downloading DXT alternates...`);
      for (const astcPath of astcFiles) {
        const dxtPath = astcPath.replace('-astc.ktx', '-dxt.ktx');
        if (existsSync(dxtPath)) continue;
        const relativePath = astcPath.substring(cacheDir.length).replace(/\\/g, '/');
        const dxtUrl = `https://${this.targetHostname}${relativePath.replace('-astc.ktx', '-dxt.ktx')}`;
        try {
          const response = await context.request.get(dxtUrl);
          if (response.ok()) {
            const body = await response.body();
            const dir = dirname(dxtPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(dxtPath, body);
            downloaded++;
          }
        } catch { /* skip */ }
      }
    }

    // 1b. Download mobile/low-detail alternates for existing assets
    // Sites serve _ld (low detail), _low, mobile variants for mobile devices
    const allCachedFiles: string[] = [];
    const findAllFiles = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fp = join(dir, entry.name);
        if (entry.isDirectory()) findAllFiles(fp);
        else if (!entry.name.endsWith('.meta.json')) allCachedFiles.push(fp);
      }
    };
    findAllFiles(cacheDir);

    const mobileAlternates: Array<{ path: string; url: string }> = [];
    // Only generate mobile alternates for 3D/media assets, not HTML/CSS/JS
    const MOBILE_ALT_EXTS = new Set(['.buf', '.glb', '.gltf', '.obj', '.fbx', '.exr', '.hdr', '.ktx', '.ktx2', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.mp3', '.ogg']);
    for (const file of allCachedFiles) {
      const rel = file.substring(cacheDir.length).replace(/\\/g, '/');
      const ext = rel.substring(rel.lastIndexOf('.')).toLowerCase();
      if (!MOBILE_ALT_EXTS.has(ext)) continue;
      const base = rel.substring(0, rel.lastIndexOf('.'));
      // Skip files that already have _ld/_low suffix
      if (base.endsWith('_ld') || base.endsWith('_low')) continue;
      // Generate _ld and _low variants
      for (const suffix of ['_ld', '_low']) {
        const altPath = `${base}${suffix}${ext}`;
        if (!existsSync(join(cacheDir, altPath))) {
          mobileAlternates.push({ path: altPath, url: `https://${this.targetHostname}${altPath}` });
        }
      }
      // Generate mobile variant for desktop.mp4 → mobile.mp4
      if (rel.includes('desktop.mp4')) {
        const mobilePath = rel.replace('desktop.mp4', 'mobile.mp4');
        if (!existsSync(join(cacheDir, mobilePath))) {
          mobileAlternates.push({ path: mobilePath, url: `https://${this.targetHostname}${mobilePath}` });
        }
      }
    }

    // Also try external domains for mobile alternates
    const extDomainsForDownload = [...extDomains].filter(d => !['vimeo.com', 'vimeocdn.com', 'twimg.com'].some(s => d.endsWith(s)));

    if (mobileAlternates.length > 0) {
      console.log(`[Crawler] Trying ${mobileAlternates.length} mobile/LD alternate assets...`);
      for (let i = 0; i < mobileAlternates.length; i += 20) {
        if (this.aborted) break;
        const batch = mobileAlternates.slice(i, i + 10);
        const results = await Promise.allSettled(
          batch.map(async ({ path: assetPath, url }) => {
            const cachePath = join(cacheDir, assetPath);
            // Try target domain first, then external domains
            const urls = [url, ...extDomainsForDownload.map(d => `https://${d}${assetPath}`)];
            for (const tryUrl of urls) {
              try {
                const response = await context.request.get(tryUrl, { timeout: 10000 });
                if (response.ok()) {
                  const ct = response.headers()['content-type'] || '';
                  if (ct.includes('text/html')) continue;
                  const body = await response.body();
                  if (body.length === 0) continue;
                  const dir = dirname(cachePath);
                  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                  writeFileSync(cachePath, body);
                  return true;
                }
              } catch { /* next url */ }
            }
            return false;
          })
        );
        downloaded += results.filter(r => r.status === 'fulfilled' && r.value).length;
      }
    }

    // 2. Scan all cached HTML and JS files for referenced assets and download missing ones
    const scanFiles: string[] = [];
    const findScannable = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) findScannable(fullPath);
        else if (entry.name.endsWith('.html') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.webmanifest') || entry.name.endsWith('.json') || entry.name.endsWith('.css')) {
          // Only scan files < 5MB to avoid extremely huge bundles
          if (statSync(fullPath).size < 5_000_000) {
            scanFiles.push(fullPath);
          }
        }
      }
    };
    findScannable(cacheDir);

    // Extract all referenced URLs from HTML and JS files
    const missingUrls = new Set<string>();
    const refPatterns = [
      /(?:data-href|data-src|data-srcset|data-background|href|src|content|poster|srcset)=["']([^"']+?)["']/gi,
      /url\(["']?([^"')]+?)["']?\)/gi,
    ];
    // JS/JSON patterns for service workers, manifests, and file references
    const jsRefPatterns = [
      /["']([^"']*?\.(?:html|webmanifest|json|js|css|png|jpe?g|ico|svg|woff2?|ttf|webp|gif|avif|mp3|mp4|ogg|wav|glb|gltf|fbx|obj|bin|hdr|ktx2?|exr|wasm|basis))["']/gi,
    ];
    // Pattern for srcset-style paths: "path.jpg 640w,path2.jpg 1920w"
    const srcsetPattern = /([\w/._-]+\.(?:png|jpe?g|webp|gif|svg|avif))\s+\d+w/gi;

    // Global collections: prefixes and bare filenames across ALL files
    const globalPrefixes = new Set<string>();
    const globalBareFilenames = new Set<string>();

    // First pass: collect path prefixes from all JS files
    // Matches both string concat ("path/" +) and template literals (`path/${`)
    for (const file of scanFiles) {
      if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
      try {
        const content = readFileSync(file, 'utf-8');
        // String concatenation: "path/" + var
        const concatPattern = /["'](\/[a-zA-Z0-9_/-]+\/)["']\s*\+/g;
        let cm;
        while ((cm = concatPattern.exec(content)) !== null) {
          globalPrefixes.add(cm[1]);
        }
        // Template literals: `path/${var}` — prefix without leading slash too
        const templatePattern = /`([a-zA-Z0-9_/-]+\/)\$\{/g;
        let tm;
        while ((tm = templatePattern.exec(content)) !== null) {
          const prefix = tm[1].startsWith('/') ? tm[1] : '/' + tm[1];
          globalPrefixes.add(prefix);
        }
      } catch {}
    }

    for (const file of scanFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        const fileDir = dirname(file);
        const relToCache = fileDir.substring(cacheDir.length).replace(/\\/g, '/');
        const isHtml = file.endsWith('.html');
        const isJson = file.endsWith('.json');
        const isCss = file.endsWith('.css');
        // Use all patterns for all file types to catch references everywhere
        const patterns = isHtml ? [...refPatterns, ...jsRefPatterns] : isCss ? refPatterns : jsRefPatterns;

        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const ref = match[1];
            if (!ref || ref.startsWith('data:') || ref.startsWith('javascript:') || ref.startsWith('#') || ref.startsWith('mailto:') || ref.length > 300) continue;
            // Skip obvious non-path strings (but allow spaces in media file paths)
            if (ref.includes('{') || ref.includes('}')) continue;
            if (ref.includes(' ') && !/\.(?:mp3|mp4|ogg|wav|webm|glb|gltf|fbx|obj|ktx2?|exr|hdr|png|jpe?g|webp|gif|svg|avif|wasm|woff2?|ttf)$/i.test(ref)) continue;

            let assetPath: string;
            if (ref.startsWith('http://') || ref.startsWith('https://')) {
              try {
                const parsed = new URL(ref);
                if (parsed.hostname !== this.targetHostname) continue;
                assetPath = parsed.pathname;
              } catch { continue; }
            } else if (ref.startsWith('/')) {
              assetPath = ref.split('?')[0].split('#')[0];
            } else {
              // Relative path — resolve relative to current file's directory
              const cleaned = ref.split('?')[0].split('#')[0];
              // Handle ../ and ./ by resolving relative to the file's directory
              if (cleaned.startsWith('../') || cleaned.startsWith('./')) {
                // Resolve: relToCache="/assets", ref="../ui/map/player.webp" → "/ui/map/player.webp"
                const parts = (relToCache + '/' + cleaned).split('/').filter(Boolean);
                const resolved: string[] = [];
                for (const p of parts) {
                  if (p === '..') resolved.pop();
                  else if (p !== '.') resolved.push(p);
                }
                assetPath = '/' + resolved.join('/');
              } else {
                const fromRoot = `/${cleaned}`;
                const fromFile = `${relToCache}/${cleaned}`;
                // Prefer root-relative if it would avoid path duplication
                assetPath = fromRoot;
                if (existsSync(join(cacheDir, fromFile)) || !cleaned.includes('/')) {
                  assetPath = fromFile;
                }
              }
              // Track bare filenames for cross-file prefix matching
              if (!cleaned.includes('/')) {
                globalBareFilenames.add(cleaned);
              }
            }

            const cachePath = join(cacheDir, assetPath);
            // Also check URL-encoded version (files with spaces stored as %20)
            const encodedAssetPath = assetPath.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
            const encodedCachePath = join(cacheDir, encodedAssetPath);
            if (!existsSync(cachePath) && !existsSync(encodedCachePath) && !existsSync(cachePath + '/index.html')) {
              missingUrls.add(assetPath);
            }
          }
        }

        // Try bare filenames with ALL discovered path prefixes across files
        // (e.g., '/videos/' found in file A + 'ponpon-mania.mp4' found in file B)
        for (const prefix of globalPrefixes) {
          for (const fname of globalBareFilenames) {
            const prefixedPath = `${prefix}${fname}`;
            const cachePath = join(cacheDir, prefixedPath);
            if (!existsSync(cachePath)) {
              missingUrls.add(prefixedPath);
            }
          }
        }

        // Scan for srcset-style paths in any file (e.g. data.json with responsive images)
        srcsetPattern.lastIndex = 0;
        let srcsetMatch;
        while ((srcsetMatch = srcsetPattern.exec(content)) !== null) {
          const ref = srcsetMatch[1];
          const assetPath = ref.startsWith('/') ? ref : (ref.includes('/') ? `/${ref}` : `${relToCache}/${ref}`);
          const cachePath = join(cacheDir, assetPath);
          if (!existsSync(cachePath)) missingUrls.add(assetPath);
        }

        // For JSON files, also look for any string values that look like file paths
        if (isJson) {
          const jsonPathPattern = /:\s*"([^"]*?(?:\/[^"]*?)?\.(?:png|jpe?g|webp|gif|svg|avif|mp4|webm|mp3|ogg|wav|glb|gltf|obj|fbx|bin|hdr|ktx|ktx2|css|js|woff2?|ttf|ico))"/gi;
          jsonPathPattern.lastIndex = 0;
          let jsonMatch;
          while ((jsonMatch = jsonPathPattern.exec(content)) !== null) {
            const ref = jsonMatch[1];
            if (!ref || ref.startsWith('data:') || ref.length > 300) continue;
            let assetPath: string;
            if (ref.startsWith('http://') || ref.startsWith('https://')) {
              try {
                const parsed = new URL(ref);
                if (parsed.hostname !== this.targetHostname) continue;
                assetPath = parsed.pathname;
              } catch { continue; }
            } else if (ref.startsWith('/')) {
              assetPath = ref;
            } else {
              // Relative path — treat as root-relative if it contains slashes
              assetPath = ref.includes('/') ? `/${ref}` : `${relToCache}/${ref}`;
            }
            const cachePath = join(cacheDir, assetPath);
            if (!existsSync(cachePath)) missingUrls.add(assetPath);
          }
        }

        // Also scan HTML for <link rel="manifest"> specifically
        if (isHtml) {
          const manifestMatch = content.match(/<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i);
          if (manifestMatch) {
            const ref = manifestMatch[1];
            // Handle ./ prefix in manifest href
            const cleaned = ref.replace(/^\.\//, '').split('?')[0].split('#')[0];
            const assetPath = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
            const cachePath = join(cacheDir, assetPath);
            if (!existsSync(cachePath)) missingUrls.add(assetPath);
          }
        }

        // Scan JS for template literals: `prefix/${var}Suffix.ext`
        // Resolves dynamic paths by finding all possible variable values
        if (!isHtml && !isJson && !isCss) {
          const templateSuffixPattern = /`([a-zA-Z0-9_/-]*\/)\$\{(\w+)\}([a-zA-Z0-9_-]*\.(?:ktx2?|webp|png|jpe?g|glb|gltf|mp4|mp3|wasm|svg|buf|exr|hdr))`/g;
          templateSuffixPattern.lastIndex = 0;
          let tsm;
          while ((tsm = templateSuffixPattern.exec(content)) !== null) {
            const prefix = tsm[1].startsWith('/') ? tsm[1] : '/' + tsm[1];
            const varName = tsm[2];
            const suffix = tsm[3]; // e.g. "Label.ktx"
            // Find string literals assigned/compared to this variable in the same file
            const valPattern = new RegExp(`(?:${varName}\\s*=\\s*|${varName}\\s*===?\\s*)"([^"]{1,80})"`, 'g');
            let vm;
            while ((vm = valPattern.exec(content)) !== null) {
              const val = vm[1];
              // Skip values that look like code/URLs, not variable values
              if (val.includes('/') || val.includes('{') || val.includes('(') || val.startsWith('http')) continue;
              const fullPath = `${prefix}${val}${suffix}`;
              if (!existsSync(join(cacheDir, fullPath))) {
                missingUrls.add(fullPath);
              }
            }
          }
        }
      } catch { /* skip unreadable files */ }
    }

    // Also add common PWA files that might be referenced from JS
    const targetPath = new URL(this.targetUrl).pathname.replace(/\/+$/, '') || '';
    const pwaFiles = [
      '/manifest.webmanifest', '/manifest.json', '/ngsw-worker.js', '/sw.js', '/service-worker.js',
      '/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png', '/apple-touch-icon.png',
      `${targetPath}/manifest.webmanifest`, `${targetPath}/manifest.json`,
      `${targetPath}/ngsw-worker.js`, `${targetPath}/ngsw.json`,
    ];
    for (const f of pwaFiles) {
      const cachePath = join(cacheDir, f);
      if (!existsSync(cachePath)) missingUrls.add(f);
    }

    // Filter out likely false positives
    const filtered = [...missingUrls].filter(p => {
      // Must have a file extension (up to 15 chars for .webmanifest etc.)
      if (!/\.\w{2,15}$/.test(p)) return false;
      // Skip node_modules, webpack internals, sourcemaps
      if (p.includes('node_modules') || p.includes('webpack') || p.endsWith('.map')) return false;
      // Skip very short names that are likely false matches
      const filename = p.split('/').pop() || '';
      if (filename.length < 3) return false;
      // Skip paths that look like npm package imports (e.g. zone.js/dist/...)
      const segments = p.split('/').filter(Boolean);
      if (segments[0] && segments[0].includes('.') && !segments[0].startsWith('_') && segments.length > 1) return false;
      // Skip Angular internal decorators (ɵdir, ɵinj, etc. -> u0275dir.js, u0275inj.js)
      if (/u0275\w+\.js$/.test(filename)) return false;
      // Skip bare filenames without any directory that don't look like real assets
      // (e.g. "Logartis", "Next.js", "Three.js", "Node.js", "summary_large_image")
      if (!p.includes('/') || p.split('/').filter(Boolean).length <= 1) {
        // Allow known asset extensions at root level (images, media, fonts, 3D, etc.)
        const assetExts = /\.(png|jpe?g|webp|gif|svg|avif|ico|mp3|mp4|webm|ogg|wav|glb|gltf|obj|fbx|hdr|ktx2?|exr|wasm|buf|basis|woff2?|ttf|otf|css|json|webmanifest|xml|txt)$/i;
        if (!assetExts.test(filename)) return false;
      }
      return true;
    });

    if (filtered.length > 0) {
      const toDownload = filtered;
      console.log(`[Crawler] Downloading ${toDownload.length} missing assets...`);
      let assetsDone = 0;
      const assetsTotal = toDownload.length;

      // Separate media (large) and other (small) assets for different batch sizes
      const MEDIA_EXTS = new Set(['.mp4', '.webm', '.mp3', '.ogg', '.wav', '.glb', '.gltf', '.obj', '.fbx', '.hdr', '.ktx', '.ktx2', '.exr', '.wasm', '.basis']);
      const mediaFiles = toDownload.filter(p => MEDIA_EXTS.has(p.substring(p.lastIndexOf('.')).toLowerCase()));
      const otherFiles = toDownload.filter(p => !MEDIA_EXTS.has(p.substring(p.lastIndexOf('.')).toLowerCase()));
      // Download small assets first (batch of 10), then media (batch of 3)
      const orderedFiles = [...otherFiles, ...mediaFiles];
      const BATCH_SIZE = 20;
      for (let i = 0; i < orderedFiles.length; i += (i >= otherFiles.length ? 3 : BATCH_SIZE)) {
        if (this.aborted) break;
        const currentBatch = i >= otherFiles.length ? 3 : BATCH_SIZE;
        const batch = orderedFiles.slice(i, i + currentBatch);
        const results = await Promise.allSettled(
          batch.map(async (assetPath) => {
            // Handle paths with spaces — encode for URL, keep original for cache
            const encodedPath = assetPath.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
            const cachePath = join(cacheDir, encodedPath);
            const ext = assetPath.substring(assetPath.lastIndexOf('.')).toLowerCase();
            const timeout = MEDIA_EXTS.has(ext) ? 15000 : 3000;
            const url = `https://${this.targetHostname}${encodedPath}`;
            try {
              const response = await context.request.get(url, { timeout });
              if (response.ok()) {
                const ct = response.headers()['content-type'] || '';
                // Skip HTML responses for non-.html files (SPA fallback pages)
                // But allow actual .html files (e.g. portfolio fragments loaded via AJAX)
                if (ct.includes('text/html') && !assetPath.endsWith('.html')) return false;
                const body = await response.body();
                if (body.length === 0) return false;
                const dir = dirname(cachePath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(cachePath, body);
                return true;
              }
            } catch { /* skip */ }
            return false;
          })
        );
        downloaded += results.filter(r => r.status === 'fulfilled' && r.value).length;
        assetsDone += batch.length;
        this.emitProgress(assetsDone, assetsTotal, `Downloading assets... (${assetsDone}/${assetsTotal})`, 'running');
      }
    }

    console.log(`[Crawler] Downloaded ${downloaded} missing asset files`);
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
    '.glb', '.gltf', '.obj', '.fbx', '.usdz', '.ktx', '.ktx2', '.basis', '.buf', '.exr', '.hdr',
    '.woff', '.woff2', '.ttf', '.otf',
    '.css', '.js', '.mjs', '.webmanifest', '.json',
  ];
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return assetExtensions.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

