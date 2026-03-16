import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __engine_dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_CACHE_DIR = resolve(__engine_dirname, '../../proxy-cache');
import { setProxyCookies } from '../proxy/proxy-plugin.js';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { CrawlQueue } from './queue.js';
import { extractPageData, type ExtractedData } from './extractor.js';
import { collectAssets, deduplicateAssets, classifyAssetUrl } from './asset-collector.js';
import type { DrizzleDB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { CrawlProgress, CrawlStatus, CdnWarning } from '@lusion-crawler/shared';

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
  private cdnAssets = new Map<string, Set<string>>(); // domain -> set of file paths

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
          '--use-gl=egl',
          '--enable-webgl',
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
      // Use string-based script to avoid esbuild __name transform breaking browser-side code
      await this.context.addInitScript({ content: `
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.__spaRoutes = new Set();
        var _origPush = history.pushState.bind(history);
        var _origReplace = history.replaceState.bind(history);
        history.pushState = function(s, t, u) {
          if (u) { try { window.__spaRoutes.add(new URL(String(u), location.href).href); } catch(e) {} }
          return _origPush(s, t, u);
        };
        history.replaceState = function(s, t, u) {
          if (u) { try { window.__spaRoutes.add(new URL(String(u), location.href).href); } catch(e) {} }
          return _origReplace(s, t, u);
        };
        window.addEventListener('popstate', function() { window.__spaRoutes.add(location.href); });
      `});

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

      // Wait for SPA routing to initialize and trigger route discovery
      await this.delay(500);
      // Scroll briefly to trigger lazy route loading
      await page.evaluate(() => {
        window.scrollBy(0, 300);
        window.scrollTo(0, 0);
      }).catch(() => {});

      const urls = await page.evaluate(({ base, hostname, prefix }) => {
        /* Collect all discoverable URLs from the page — SPA-aware */
        const pageUrls = new Set<string>();
        const skipPaths = ['/signup', '/login', '/register', '/signin', '/auth', '/oauth', '/sso', '/account', '/dashboard', '/console'];

        // Helper wrapped in object to avoid esbuild __name transform
        const h = { add(href: string) {
          try {
            const resolved = new URL(href, base);
            if (resolved.hostname !== hostname && !resolved.hostname.endsWith('.' + hostname)) return;
            const lp = resolved.pathname.toLowerCase();
            for (let i = 0; i < skipPaths.length; i++) {
              if (lp === skipPaths[i] || lp.startsWith(skipPaths[i] + '/')) return;
            }
            if (!prefix || resolved.pathname.startsWith(prefix)) pageUrls.add(resolved.href);
          } catch {}
        }};

        // 1. <a href> links
        document.querySelectorAll('a[href]').forEach((link) => {
          const v = link.getAttribute('href');
          if (v) h.add(v);
        });

        // 2. SPA routes from pushState/replaceState interceptor
        const sr = (window as any).__spaRoutes;
        if (sr instanceof Set) sr.forEach((u: string) => h.add(u));

        // 3. Router attributes (Vue Router to="", data-href, etc.)
        document.querySelectorAll('[to], [data-href], [data-to], [data-route], [data-link]').forEach((el) => {
          ['to', 'data-href', 'data-to', 'data-route', 'data-link'].forEach((a) => {
            const v = el.getAttribute(a);
            if (v && (v[0] === '/' || v.startsWith('http'))) h.add(v);
          });
        });

        // 4. Hash-based routing (#/ or #!/)
        document.querySelectorAll('a[href^="#/"], a[href^="#!/"]').forEach((el) => {
          const v = el.getAttribute('href');
          if (v) h.add(v.replace(/^#!?/, ''));
        });

        // 5. Nuxt route data
        try {
          const nd = (window as any).__NUXT__;
          if (nd) {
            const ra = nd.routeTree || (nd.config && nd.config.routes) || [];
            const stk = Array.isArray(ra) ? ra.slice() : [];
            while (stk.length) { const r = stk.pop(); if (r && typeof r.path === 'string') h.add(r.path); if (r && Array.isArray(r.children)) stk.push(...r.children); }
          }
        } catch {}

        // 6. Next.js page data
        try {
          const nd = (window as any).__NEXT_DATA__;
          if (nd && nd.props) {
            const q: [any, number][] = [[nd.props, 0]];
            while (q.length) {
              const pair = q.pop()!; const obj = pair[0]; const d = pair[1];
              if (d > 4 || !obj) continue;
              if (typeof obj === 'string' && obj[0] === '/' && obj.length < 200 && obj.indexOf('.') === -1) { h.add(obj); }
              else if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) q.push([obj[i], d + 1]); }
              else if (typeof obj === 'object') { const ks = Object.keys(obj); for (let i = 0; i < ks.length; i++) { const k = ks[i]; if (k === 'href' || k === 'url' || k === 'path' || k === 'route' || k === 'slug' || k === 'to' || k === 'link' || k === 'pathname') { const v = obj[k]; if (typeof v === 'string' && v[0] === '/') h.add(v); } q.push([obj[k], d + 1]); } }
            }
          }
        } catch {}

        // 7. JSON route data in script tags
        document.querySelectorAll('script[type="application/json"], script#__NUXT_DATA__').forEach((el) => {
          try {
            const text = el.textContent;
            if (!text || text.length > 50000) return;
            const pm = text.matchAll(/"(\/[a-z0-9][a-z0-9._~:@!$&'()*+,;=/-]{0,150})"/gi);
            for (const m of pm) { const p = m[1]; if (/\.(js|css|png|jpg|svg|woff|json|xml|ico|mp[34]|webp|avif|gif)$/i.test(p)) continue; if (p.startsWith('/api/') || p.startsWith('/_')) continue; h.add(p); }
          } catch {}
        });

        return [...pageUrls];
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
      const cacheDir = join(PROXY_CACHE_DIR, this.targetHostname);
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

      // Intercept network responses — cache assets from external domains (e.g. lusion.dev for lusion.co)
      // Assets from the target domain are already cached by the proxy
      // Only skip pure analytics/tracking — NOT font CDNs or asset CDNs
      const skipDomains = ['google-analytics.com', 'googletagmanager.com', 'facebook.net', 'doubleclick.net', 'hotjar.com', 'clarity.ms', 'sentry.io', 'segment.com', 'mixpanel.com', 'amplitude.com'];
      // CDN domains to cache but not warn about (fonts, common CDNs)
      const silentCdnDomains = ['fonts.googleapis.com', 'fonts.gstatic.com'];
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

            const isSilentCdn = silentCdnDomains.some(d => hostname.endsWith(d));

            // Track CDN/external domain assets for warnings (skip silent CDNs like fonts)
            if (!isTargetDomain && !isSkipped && !isSilentCdn && isAsset) {
              const files = this.cdnAssets.get(hostname) || new Set();
              files.add(parsed.pathname);
              this.cdnAssets.set(hostname, files);
            }

            // Cache ALL non-skipped assets (both target domain, external, and silent CDNs)
            if ((isTargetDomain || isAsset) && !isSkipped) {
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

  // Known CDN frameworks detection
  private static CDN_FRAMEWORKS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /three(\.module)?\.(?:min\.)?js/i, name: 'Three.js' },
    { pattern: /spline.*runtime/i, name: 'Spline 3D' },
    { pattern: /gsap|ScrollTrigger|DrawSVG/i, name: 'GSAP' },
    { pattern: /pixi(\.min)?\.js/i, name: 'PixiJS' },
    { pattern: /babylon(\.min)?\.js/i, name: 'Babylon.js' },
    { pattern: /aframe(\.min)?\.js/i, name: 'A-Frame' },
    { pattern: /p5(\.min)?\.js/i, name: 'p5.js' },
    { pattern: /lottie/i, name: 'Lottie' },
    { pattern: /model-viewer/i, name: 'Model Viewer' },
    { pattern: /playcanvas/i, name: 'PlayCanvas' },
    { pattern: /\.splinecode$/i, name: 'Spline 3D' },
    { pattern: /\.glb$|\.gltf$/i, name: '3D Model' },
    { pattern: /\.hdr$|\.exr$/i, name: 'HDR Environment' },
  ];

  private buildCdnWarnings(): CdnWarning[] {
    const warnings: CdnWarning[] = [];
    for (const [domain, files] of this.cdnAssets) {
      let framework: string | null = null;
      const fileList = [...files];
      // Detect framework from file names
      for (const file of fileList) {
        for (const { pattern, name } of Crawler.CDN_FRAMEWORKS) {
          if (pattern.test(file)) {
            framework = name;
            break;
          }
        }
        if (framework) break;
      }
      warnings.push({
        domain,
        files: fileList.slice(0, 20), // Limit to 20 files per domain
        framework,
      });
    }
    return warnings;
  }

  private emitProgress(parsed: number, total: number, currentUrl: string, status: CrawlStatus): void {
    if (this.onProgress) {
      this.onProgress({
        jobId: this.jobId,
        parsed,
        total,
        currentUrl,
        status,
        cdnWarnings: this.cdnAssets.size > 0 ? this.buildCdnWarnings() : undefined,
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
    const cacheDir = join(PROXY_CACHE_DIR, this.targetHostname);
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

    // 1. Download texture format alternates (ASTC↔DXT↔S3TC↔ETC)
    // Sites store compressed textures in format-specific dirs: /compressed/astc/, /compressed/s3tc/, etc.
    const TEXTURE_FORMATS = ['astc', 's3tc', 'dxt', 'etc', 'etc1', 'pvrtc'];
    const ktxFiles: string[] = [];
    const findKtx = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) findKtx(fullPath);
        else if (entry.name.endsWith('.ktx') || entry.name.endsWith('.ktx2')) ktxFiles.push(fullPath);
      }
    };
    findKtx(cacheDir);

    // a) Suffix-based alternates: file-astc.ktx → file-dxt.ktx, file-s3tc.ktx, etc.
    const suffixKtx = ktxFiles.filter(f => TEXTURE_FORMATS.some(fmt => f.includes(`-${fmt}.ktx`)));
    if (suffixKtx.length > 0) {
      console.log(`[Crawler] Found ${suffixKtx.length} suffix-format textures, downloading alternates...`);
      for (const filePath of suffixKtx) {
        const currentFmt = TEXTURE_FORMATS.find(fmt => filePath.includes(`-${fmt}.ktx`))!;
        for (const altFmt of TEXTURE_FORMATS) {
          if (altFmt === currentFmt) continue;
          const altPath = filePath.replace(`-${currentFmt}.ktx`, `-${altFmt}.ktx`);
          if (existsSync(altPath)) continue;
          const relativePath = altPath.substring(cacheDir.length).replace(/\\/g, '/');
          try {
            const response = await context.request.get(`https://${this.targetHostname}${relativePath}`, { timeout: 120000 });
            if (response.ok()) {
              const body = await response.body();
              const dir = dirname(altPath);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              writeFileSync(altPath, body);
              downloaded++;
            }
          } catch { /* skip */ }
        }
        if (this.aborted) break;
      }
    }

    // b) Directory-based alternates: /compressed/astc/file.ktx → /compressed/s3tc/file.ktx
    const dirBasedKtx = ktxFiles.filter(f => {
      const rel = f.substring(cacheDir.length).replace(/\\/g, '/');
      return TEXTURE_FORMATS.some(fmt => rel.includes(`/${fmt}/`));
    });
    if (dirBasedKtx.length > 0) {
      const seen = new Set<string>();
      console.log(`[Crawler] Found ${dirBasedKtx.length} directory-format textures, downloading alternates...`);
      for (const filePath of dirBasedKtx) {
        const rel = filePath.substring(cacheDir.length).replace(/\\/g, '/');
        const currentFmt = TEXTURE_FORMATS.find(fmt => rel.includes(`/${fmt}/`))!;
        for (const altFmt of TEXTURE_FORMATS) {
          if (altFmt === currentFmt) continue;
          const altRel = rel.replace(`/${currentFmt}/`, `/${altFmt}/`);
          if (seen.has(altRel)) continue;
          seen.add(altRel);
          const altPath = join(cacheDir, altRel);
          if (existsSync(altPath)) continue;
          try {
            const response = await context.request.get(`https://${this.targetHostname}${altRel}`, { timeout: 120000 });
            if (response.ok()) {
              // Skip content-type check for KTX/texture files — S3 often misconfigures MIME types
              const body = await response.body();
              if (body.length === 0) continue;
              const dir = dirname(altPath);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              writeFileSync(altPath, body);
              downloaded++;
            }
          } catch { /* skip */ }
        }
        if (this.aborted) break;
      }
    }

    // c) Quality/variant suffixes for KTX textures: file.ktx → file_flat@mipmaps.ktx, file_pot@mipmaps.ktx, etc.
    const KTX_SUFFIXES = ['_flat@mipmaps', '_pot@mipmaps', '_low@mipmaps', '_hd@mipmaps'];
    // Refresh KTX file list after format alternates download
    const allKtxNow: string[] = [];
    const findKtxAll = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fp = join(dir, entry.name);
        if (entry.isDirectory()) findKtxAll(fp);
        else if (entry.name.endsWith('.ktx') || entry.name.endsWith('.ktx2')) allKtxNow.push(fp);
      }
    };
    findKtxAll(cacheDir);

    console.log(`[Crawler] Found ${allKtxNow.length} KTX textures for quality variant probing`);
    if (allKtxNow.length > 0) {
      // Deduplicate: only try suffix variants for base textures (not already suffixed)
      const basesForSuffix = allKtxNow.filter(f => !KTX_SUFFIXES.some(s => f.includes(s)));
      const suffixTasks: Array<{ path: string; url: string }> = [];
      for (const filePath of basesForSuffix) {
        const rel = filePath.substring(cacheDir.length).replace(/\\/g, '/');
        const ext = rel.endsWith('.ktx2') ? '.ktx2' : '.ktx';
        let base = rel.substring(0, rel.length - ext.length);
        // Strip existing @mipmaps suffix so we get file_flat@mipmaps.ktx, not file@mipmaps_flat@mipmaps.ktx
        base = base.replace(/@mipmaps$/, '');
        for (const suffix of KTX_SUFFIXES) {
          const altRel = `${base}${suffix}${ext}`;
          const altPath = join(cacheDir, altRel);
          if (!existsSync(altPath)) {
            suffixTasks.push({ path: altRel, url: `https://${this.targetHostname}${altRel}` });
          }
        }
      }
      console.log(`[Crawler] ${basesForSuffix.length} base KTX textures → ${suffixTasks.length} suffix variants to try`);
      if (suffixTasks.length > 0) {
        console.log(`[Crawler] Trying ${suffixTasks.length} KTX quality variants (_flat, _pot, _low, _hd)...`);
        for (let i = 0; i < suffixTasks.length; i += 20) {
          if (this.aborted) break;
          const batch = suffixTasks.slice(i, i + 20);
          const results = await Promise.allSettled(
            batch.map(async ({ path: assetPath, url }) => {
              try {
                const response = await context.request.get(url, { timeout: 120000 });
                if (i === 0) console.log(`[Crawler] KTX suffix probe: ${url} → status ${response.status()}`);
                if (response.ok()) {
                  // Skip content-type check for KTX — some servers (S3) misconfigure MIME types
                  const body = await response.body();
                  if (body.length === 0) return false;
                  const cachePath = join(cacheDir, assetPath);
                  const dir = dirname(cachePath);
                  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                  writeFileSync(cachePath, body);
                  return true;
                }
              } catch (err) {
                  console.log(`[Crawler] KTX suffix fetch error for ${url}: ${err instanceof Error ? err.message : err}`);
              }
              return false;
            })
          );
          const batchOk = results.filter(r => r.status === 'fulfilled' && r.value).length;
          downloaded += batchOk;
          if (i === 0) console.log(`[Crawler] First KTX suffix batch: ${batchOk}/${batch.length} ok, sample URL: ${batch[0]?.url}`);
        }
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
      console.log(`[Crawler] Trying ${mobileAlternates.length} mobile/LD alternate assets (target domain only)...`);
      for (let i = 0; i < mobileAlternates.length; i += 20) {
        if (this.aborted) break;
        const batch = mobileAlternates.slice(i, i + 20);
        const results = await Promise.allSettled(
          batch.map(async ({ path: assetPath, url }) => {
            const cachePath = join(cacheDir, assetPath);
            // Only try target domain (external domain iteration causes massive slowdown)
            try {
              const response = await context.request.get(url, { timeout: 120000 });
              if (response.ok()) {
                const ct = response.headers()['content-type'] || '';
                if (ct.includes('text/html')) return false;
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
    // Cross-origin CMS domains found in _ipx URLs (e.g. admin.example.com from /_ipx/.../https://admin.example.com/uploads/...)
    const cmsOrigins = new Map<string, string>(); // path prefix → full origin URL (e.g. "/uploads/" → "https://admin.example.com")

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
            let ref = match[1];
            if (!ref || ref.startsWith('data:') || ref.startsWith('javascript:') || ref.startsWith('#') || ref.startsWith('mailto:') || ref.length > 300) continue;
            // Decode HTML entities (e.g. &amp; → &) since we extract from raw HTML source
            if (isHtml) {
              ref = ref.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            }
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
              // Detect cross-origin CMS domains in _ipx URLs (Nuxt image proxy)
              // e.g. /_ipx/.../https://admin.example.com/uploads/file.jpg
              if (isHtml && assetPath.includes('/_ipx/') && assetPath.includes('https://')) {
                const ipxMatch = assetPath.match(/\/https?:\/\/([^/]+)(\/[^/]+\/)/);
                if (ipxMatch && ipxMatch[1] !== this.targetHostname) {
                  const cmsHost = ipxMatch[1];
                  const pathPrefix = ipxMatch[2]; // e.g. "/uploads/"
                  cmsOrigins.set(pathPrefix, `https://${cmsHost}`);
                }
              }
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
                const fromFile = relToCache ? `${relToCache}/${cleaned}` : `/${cleaned}`;
                // For HTML/CSS files, prefer file-relative resolution (standard browser behavior)
                // For JS files, prefer root-relative (bundlers usually use absolute paths)
                if (isHtml || isCss) {
                  assetPath = fromFile;
                } else {
                  assetPath = fromRoot;
                  if (existsSync(join(cacheDir, fromFile)) || !cleaned.includes('/')) {
                    assetPath = fromFile;
                  }
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

        // Try bare filenames with discovered path prefixes (limited to avoid combinatorial explosion)
        // Only combine if total combinations < 500
        if (globalPrefixes.size * globalBareFilenames.size < 500) {
          for (const prefix of globalPrefixes) {
            for (const fname of globalBareFilenames) {
              const prefixedPath = `${prefix}${fname}`;
              const cachePath = join(cacheDir, prefixedPath);
              if (!existsSync(cachePath)) {
                missingUrls.add(prefixedPath);
              }
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

          // Handle extensionless data-filename with data-type (e.g. lusion.co project pages)
          // <div data-filename="/assets/projects/foo/image1" data-type="image">
          // JS appends .webp for images, .mp4 for videos at runtime
          const dataFilenamePattern = /data-filename=["']([^"']+)["'][^>]*data-type=["'](image|video)["']/g;
          const dataFilenamePatternRev = /data-type=["'](image|video)["'][^>]*data-filename=["']([^"']+)["']/g;
          let dfm;
          dataFilenamePattern.lastIndex = 0;
          while ((dfm = dataFilenamePattern.exec(content)) !== null) {
            const basePath = dfm[1];
            const type = dfm[2];
            const ext = type === 'video' ? '.mp4' : '.webp';
            const assetPath = basePath.startsWith('/') ? basePath + ext : '/' + basePath + ext;
            if (!existsSync(join(cacheDir, assetPath))) missingUrls.add(assetPath);
          }
          dataFilenamePatternRev.lastIndex = 0;
          while ((dfm = dataFilenamePatternRev.exec(content)) !== null) {
            const type = dfm[1];
            const basePath = dfm[2];
            const ext = type === 'video' ? '.mp4' : '.webp';
            const assetPath = basePath.startsWith('/') ? basePath + ext : '/' + basePath + ext;
            if (!existsSync(join(cacheDir, assetPath))) missingUrls.add(assetPath);
          }
        }

        // Scan for string concat patterns: "path/" + var + ".ext" where var can be "m" or "d" (mobile/desktop)
        // Also handles inline scripts in HTML
        if (isHtml || (!isJson && !isCss)) {
          // Pattern: "/path/" + var + ".ext?" or "/path/" + var + ".ext"
          const concatPathPattern = /["'](\/[a-zA-Z0-9_/-]+\/)["']\s*\+\s*(\w+)\s*\+\s*["'](\.\w{2,6}(?:\?[^"']*)?)["']/g;
          concatPathPattern.lastIndex = 0;
          let cpm;
          while ((cpm = concatPathPattern.exec(content)) !== null) {
            const prefix = cpm[1];
            const varName = cpm[2];
            const suffix = cpm[3].split('?')[0]; // strip query params
            // Find possible values for varName in same file
            const valPat = new RegExp(`(?:["'])([a-zA-Z0-9_-]{1,20})(?:["'])\\s*(?::|===?\\s*${varName}|${varName}\\s*===?)`, 'g');
            let vm;
            const vals = new Set<string>();
            while ((vm = valPat.exec(content)) !== null) vals.add(vm[1]);
            // Also try common mobile/desktop variants
            vals.add('m'); vals.add('d');
            for (const val of vals) {
              const assetPath = `${prefix}${val}${suffix}`;
              if (!existsSync(join(cacheDir, assetPath))) missingUrls.add(assetPath);
            }
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

    if (cmsOrigins.size > 0) {
      console.log(`[Crawler] Detected CMS origins: ${[...cmsOrigins.entries()].map(([p, o]) => `${p} → ${o}`).join(', ')}`);
    }

    if (filtered.length > 0) {
      const toDownload = filtered;
      console.log(`[Crawler] Downloading ${toDownload.length} missing assets...`);
      // Log first 10 missing URLs for debugging
      for (const u of toDownload.slice(0, 10)) console.log(`[Crawler]   missing: ${u.substring(0, 150)}`);
      let assetsDone = 0;
      const assetsTotal = toDownload.length;
      const dlStart = Date.now();

      // Separate media (large) and other (small) assets for different batch sizes
      const MEDIA_EXTS = new Set(['.mp4', '.webm', '.mp3', '.ogg', '.wav', '.glb', '.gltf', '.obj', '.fbx', '.hdr', '.ktx', '.ktx2', '.exr', '.wasm', '.basis']);
      const mediaFiles = toDownload.filter(p => MEDIA_EXTS.has(p.substring(p.lastIndexOf('.')).toLowerCase()));
      const otherFiles = toDownload.filter(p => !MEDIA_EXTS.has(p.substring(p.lastIndexOf('.')).toLowerCase()));
      // Download small assets first (batch of 10), then media (batch of 3)
      const orderedFiles = [...otherFiles, ...mediaFiles];
      const BATCH_SIZE = 20;
      for (let i = 0; i < orderedFiles.length; i += (i >= otherFiles.length ? 10 : BATCH_SIZE)) {
        if (this.aborted) break;
        const currentBatch = i >= otherFiles.length ? 10 : BATCH_SIZE;
        const batch = orderedFiles.slice(i, i + currentBatch);
        const results = await Promise.allSettled(
          batch.map(async (assetPath) => {
            // Handle paths with spaces — encode for URL, keep original for cache
            const encodedPath = assetPath.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
            const cachePath = join(cacheDir, encodedPath);
            const url = `https://${this.targetHostname}${encodedPath}`;
            try {
              const response = await context.request.get(url, { timeout: 120000 });
              if (response.ok()) {
                const ct = response.headers()['content-type'] || '';
                // Skip HTML responses for non-.html files (SPA fallback pages)
                // But allow actual .html files (e.g. portfolio fragments loaded via AJAX)
                if (ct.includes('text/html') && !assetPath.endsWith('.html')) {
                  console.log(`[Crawler] SKIP (html fallback): ${assetPath.substring(0, 120)}`);
                  // If target returned HTML fallback, try cross-origin CMS domain (e.g. Strapi uploads)
                  for (const [prefix, origin] of cmsOrigins) {
                    if (assetPath.startsWith(prefix)) {
                      try {
                        const cmsUrl = `${origin}${encodedPath}`;
                        const cmsResp = await context.request.get(cmsUrl, { timeout: 120000 });
                        if (cmsResp.ok()) {
                          const cmsCt = cmsResp.headers()['content-type'] || '';
                          if (!cmsCt.includes('text/html')) {
                            const body = await cmsResp.body();
                            if (body.length > 0) {
                              const dir = dirname(cachePath);
                              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                              writeFileSync(cachePath, body);
                              return true;
                            }
                          }
                        }
                      } catch {}
                    }
                  }
                  return false;
                }
                const body = await response.body();
                if (body.length === 0) return false;
                const dir = dirname(cachePath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(cachePath, body);
                return true;
              } else {
                console.log(`[Crawler] SKIP (status ${response.status()}): ${assetPath.substring(0, 120)}`);
              }
            } catch (err) {
              console.log(`[Crawler] FAIL (${err instanceof Error ? err.message.substring(0, 60) : 'error'}): ${assetPath.substring(0, 120)}`);
            }
            return false;
          })
        );
        downloaded += results.filter(r => r.status === 'fulfilled' && r.value).length;
        assetsDone += batch.length;
        const elapsed = ((Date.now() - dlStart) / 1000).toFixed(0);
        console.log(`[Crawler] Assets ${assetsDone}/${assetsTotal} (${downloaded} ok, ${elapsed}s elapsed)`);
        this.emitProgress(assetsDone, assetsTotal, `Downloading assets... (${assetsDone}/${assetsTotal})`, 'running');
      }
    }

    console.log(`[Crawler] Downloaded ${downloaded} missing asset files`);

    // Second pass: scan newly downloaded HTML files for nested asset references
    if (downloaded > 0) {
      const newHtmlFiles: string[] = [];
      const walkNew = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walkNew(full);
          else if (entry.name.endsWith('.html') && !entry.name.endsWith('.meta.json')) newHtmlFiles.push(full);
        }
      };
      walkNew(cacheDir);

      const extraMissing = new Set<string>();
      const allPatterns = [
        /(?:data-href|data-src|data-background|href|src|content|poster)=["']([^"']+?)["']/gi,
        /url\(["']?([^"')]+?)["']?\)/gi,
        /["']([^"']*?\.(?:png|jpe?g|ico|svg|woff2?|ttf|webp|gif|avif|mp3|mp4|ogg|wav|glb|gltf|fbx|obj|bin|hdr|ktx2?|exr|wasm|css|js))["']/gi,
      ];

      for (const file of newHtmlFiles) {
        try {
          const content = readFileSync(file, 'utf-8');
          for (const pattern of allPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
              const ref = match[1];
              if (!ref || ref.startsWith('data:') || ref.startsWith('http') || ref.startsWith('#') || ref.startsWith('mailto:') || ref.length > 300) continue;
              const cleaned = ref.split('?')[0].split('#')[0];
              const assetPath = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
              const cachePath = join(cacheDir, assetPath);
              if (!existsSync(cachePath) && /\.\w{2,10}$/.test(assetPath)) {
                extraMissing.add(assetPath);
              }
            }
          }
        } catch { /* skip */ }
      }

      if (extraMissing.size > 0) {
        console.log(`[Crawler] Second pass: downloading ${extraMissing.size} assets from new HTML files...`);
        let extraDownloaded = 0;
        const extraBatch = [...extraMissing];
        for (let i = 0; i < extraBatch.length; i += 20) {
          if (this.aborted) break;
          const batch = extraBatch.slice(i, i + 20);
          const results = await Promise.allSettled(
            batch.map(async (assetPath) => {
              const encodedPath = assetPath.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
              const cachePath = join(cacheDir, encodedPath);
              const url = `https://${this.targetHostname}${encodedPath}`;
              try {
                const response = await context.request.get(url, { timeout: 120000 });
                if (response.ok()) {
                  const ct = response.headers()['content-type'] || '';
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
          extraDownloaded += results.filter(r => r.status === 'fulfilled' && r.value).length;
        }
        console.log(`[Crawler] Second pass: downloaded ${extraDownloaded} extra assets`);
        downloaded += extraDownloaded;
      }
    }

    // Final step: rewrite external CDN URLs in cached JS/HTML files to local relative paths
    // This ensures the cached site works offline without reaching out to CDN origins
    this.rewriteExternalCdnUrls(cacheDir);
  }

  /** Rewrite external CDN URLs in cached JS/HTML files to local relative paths */
  private rewriteExternalCdnUrls(cacheDir: string): void {
    // Collect external origins from .meta.json files
    const externalOrigins = new Set<string>();
    const walkMeta = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkMeta(full);
        else if (entry.name.endsWith('.meta.json')) {
          try {
            const meta = JSON.parse(readFileSync(full, 'utf-8'));
            if (meta.hostname && meta.hostname !== this.targetHostname) {
              const parsed = new URL(meta.url);
              externalOrigins.add(parsed.origin);
            }
          } catch {}
        }
      }
    };
    walkMeta(cacheDir);

    if (externalOrigins.size === 0) return;
    console.log(`[Crawler] Rewriting external CDN origins in cached files: ${[...externalOrigins].join(', ')}`);

    // Walk all JS and HTML files and replace external origins with empty string
    let rewritten = 0;
    const walkRewrite = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkRewrite(full);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
          if (entry.name.endsWith('.meta.json')) continue;
          try {
            let content = readFileSync(full, 'utf-8');
            let changed = false;
            for (const origin of externalOrigins) {
              if (content.includes(origin)) {
                content = content.replaceAll(origin, '');
                changed = true;
              }
            }
            if (changed) {
              writeFileSync(full, content);
              rewritten++;
            }
          } catch {}
        }
      }
    };
    walkRewrite(cacheDir);
    if (rewritten > 0) {
      console.log(`[Crawler] Rewrote external CDN URLs in ${rewritten} files`);
    }
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
    'model/', 'application/octet-stream', 'application/wasm',
  ];
  if (assetContentTypes.some((t) => contentType.startsWith(t))) return true;

  const assetExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico',
    '.mp4', '.webm', '.ogg', '.mov',
    '.glb', '.gltf', '.obj', '.fbx', '.usdz', '.ktx', '.ktx2', '.basis', '.buf', '.exr', '.hdr',
    '.woff', '.woff2', '.ttf', '.otf',
    '.css', '.js', '.mjs', '.webmanifest', '.json',
    '.wasm', '.mp3', '.wav', '.flac', '.aac',
    '.dds', '.pvr', '.splinecode',
  ];
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return assetExtensions.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

