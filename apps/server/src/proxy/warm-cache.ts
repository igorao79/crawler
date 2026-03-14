import { chromium, type Page, type BrowserContext } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = './proxy-cache';
const PROXY_URL = 'http://localhost:3002';
const DEFAULT_MAX_DEPTH = 5;
const PAGE_LOAD_WAIT = 12000; // Wait for 3D/WebGL assets
const SCROLL_WAIT = 3000;
const DELAY_BETWEEN_PAGES = 2000;
const PAGE_TIMEOUT = 90000;

interface QueueItem {
  url: string;
  depth: number;
  parentUrl: string | null;
}

export interface CrawlSiteProgress {
  visited: number;
  queued: number;
  currentUrl: string;
  depth: number;
}

export type CrawlSiteCallback = (progress: CrawlSiteProgress) => void;

function getCachePath(urlPath: string): string {
  let safePath = urlPath.replace(/[?#].*$/, '');
  if (safePath.endsWith('/') || safePath === '') safePath += 'index.html';
  const lastSegment = safePath.split('/').pop() || '';
  if (!lastSegment.includes('.')) safePath += '/index.html';
  return join(CACHE_DIR, safePath);
}

function getQueryCachePath(fullUrl: string, target: string): string | null {
  const parsed = new URL(fullUrl, target);
  if (!parsed.search) return null;
  const hash = createHash('md5').update(fullUrl).digest('hex').slice(0, 12);
  const base = getCachePath(parsed.pathname);
  const dir = dirname(base);
  const ext = base.split('.').pop() || 'bin';
  return join(dir, `_query_${hash}.${ext}`);
}

function getMetaPath(cachePath: string): string {
  return cachePath + '.meta.json';
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove hash and trailing slash for consistency
    let path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`;
  } catch {
    return url;
  }
}

function isInternalUrl(url: string, targetHostname: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === targetHostname || parsed.hostname.endsWith('.' + targetHostname);
  } catch {
    return false;
  }
}

function shouldSkipUrl(url: string): boolean {
  const skip = [
    '#', 'mailto:', 'tel:', 'javascript:',
    '.pdf', '.zip', '.rar',
    '/cdn-cgi/', '/api/', '/__',
  ];
  return skip.some(s => url.includes(s));
}

async function extractLinks(page: Page, target: string, targetHostname: string): Promise<string[]> {
  return page.evaluate(({ base, hostname }: { base: string; hostname: string }) => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (!href) return;
      try {
        const url = new URL(href, base);
        if (url.hostname === hostname || url.hostname.endsWith('.' + hostname)) {
          links.push(url.href);
        }
      } catch {
        // skip
      }
    });
    return [...new Set(links)];
  }, { base: target, hostname: targetHostname });
}

async function cachePageThroughProxy(
  context: BrowserContext,
  url: string,
  depth: number,
  target: string,
  targetHostname: string,
  proxyUrl: string,
): Promise<string[]> {
  const page = await context.newPage();
  const discoveredLinks: string[] = [];
  let assetCount = 0;

  // Count cached assets
  page.on('response', (response) => {
    const resUrl = response.url();
    if (resUrl.startsWith(proxyUrl)) {
      assetCount++;
    }
  });

  try {
    // Navigate through proxy (rewrite URL to go through localhost:3002)
    const proxyPageUrl = url.replace(target, proxyUrl);
    console.log(`\n  [D${depth}] ${url}`);
    console.log(`         -> ${proxyPageUrl}`);

    await page.goto(proxyPageUrl, {
      waitUntil: 'load',
      timeout: PAGE_TIMEOUT,
    });

    // Wait for JS/WebGL rendering + asset loading
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    // Scroll down to trigger lazy loading
    await page.evaluate(async () => {
      const height = document.body.scrollHeight;
      const step = window.innerHeight;
      for (let y = 0; y < height; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 300));
      }
    });
    await page.waitForTimeout(SCROLL_WAIT);

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Extract all internal links for BFS
    const links = await extractLinks(page, target, targetHostname);
    for (const link of links) {
      if (!shouldSkipUrl(link) && isInternalUrl(link, targetHostname)) {
        discoveredLinks.push(normalizeUrl(link));
      }
    }

    console.log(`         Loaded ${assetCount} assets, found ${discoveredLinks.length} links`);
  } catch (err) {
    console.error(`         ERROR: ${err instanceof Error ? err.message : err}`);
  } finally {
    await page.close();
  }

  return discoveredLinks;
}

/**
 * Crawl a site using BFS through a caching proxy.
 * @param targetUrl - The URL of the site to crawl (e.g. 'https://example.com')
 * @param maxDepth - Maximum BFS depth
 * @param onProgress - Optional progress callback
 * @param proxyUrl - URL of the caching proxy (defaults to http://localhost:3002)
 */
export async function crawlSite(
  targetUrl: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  onProgress?: CrawlSiteCallback,
  proxyUrl: string = PROXY_URL,
): Promise<{ totalPages: number; totalErrors: number }> {
  const target = targetUrl.replace(/\/+$/, '');
  const targetHostname = new URL(target).hostname;

  console.log('='.repeat(60));
  console.log('  Site Crawler (BFS to depth ' + maxDepth + ')');
  console.log('  Target: ' + target);
  console.log('  Proxy: ' + proxyUrl);
  console.log('  Cache: ' + CACHE_DIR);
  console.log('='.repeat(60));

  // Check proxy is running
  try {
    const check = await fetch(`${proxyUrl}/__proxy__/stats`);
    if (!check.ok) throw new Error('Proxy not responding');
    console.log('\n  Proxy is running\n');
  } catch {
    console.error('\n  ERROR: Proxy is not running on ' + proxyUrl);
    console.error('  Start it first or use the integrated server.\n');
    throw new Error('Proxy is not running on ' + proxyUrl);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  // Hide webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // BFS queue — start with the root URL
  const queue: QueueItem[] = [
    { url: `${target}/`, depth: 0, parentUrl: null },
  ];
  const visited = new Set<string>();
  let totalPages = 0;
  let totalErrors = 0;
  const depthStats: Record<number, number> = {};

  while (queue.length > 0) {
    const item = queue.shift()!;
    const normalized = normalizeUrl(item.url);

    if (visited.has(normalized)) continue;
    if (item.depth > maxDepth) continue;

    visited.add(normalized);
    totalPages++;
    depthStats[item.depth] = (depthStats[item.depth] || 0) + 1;

    if (onProgress) {
      onProgress({
        visited: totalPages,
        queued: queue.length,
        currentUrl: normalized,
        depth: item.depth,
      });
    }

    try {
      const links = await cachePageThroughProxy(context, normalized, item.depth, target, targetHostname, proxyUrl);

      // Add discovered links to queue at depth + 1
      if (item.depth < maxDepth) {
        for (const link of links) {
          if (!visited.has(normalizeUrl(link))) {
            queue.push({
              url: link,
              depth: item.depth + 1,
              parentUrl: normalized,
            });
          }
        }
      }
    } catch (err) {
      totalErrors++;
      console.error(`  Error on ${normalized}: ${err instanceof Error ? err.message : err}`);
    }

    // Polite delay
    if (queue.length > 0) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
    }
  }

  await context.close();
  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  CRAWL COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Total pages visited: ${totalPages}`);
  console.log(`  Errors: ${totalErrors}`);
  console.log(`  Depth breakdown:`);
  for (const [d, count] of Object.entries(depthStats).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`    Depth ${d}: ${count} pages`);
  }

  console.log(`\n  All pages cached! Served via the proxy.`);

  return { totalPages, totalErrors };
}

// Allow running as standalone script: npx tsx src/proxy/warm-cache.ts <url> [maxDepth]
const isMainModule = process.argv[1]?.replace(/\\/g, '/').includes('warm-cache');
if (isMainModule) {
  const targetArg = process.argv[2] || 'https://lusion.co';
  const depthArg = parseInt(process.argv[3] || String(DEFAULT_MAX_DEPTH), 10);

  crawlSite(targetArg, depthArg).catch((err) => {
    console.error('Crawler failed:', err);
    process.exit(1);
  });
}
