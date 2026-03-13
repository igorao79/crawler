import { chromium, type Page, type BrowserContext } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = './proxy-cache';
const TARGET = 'https://lusion.co';
const PROXY_URL = 'http://localhost:3002';
const MAX_DEPTH = 5;
const PAGE_LOAD_WAIT = 12000; // Wait for 3D/WebGL assets
const SCROLL_WAIT = 3000;
const DELAY_BETWEEN_PAGES = 2000;
const PAGE_TIMEOUT = 90000;

interface QueueItem {
  url: string;
  depth: number;
  parentUrl: string | null;
}

function getCachePath(urlPath: string): string {
  let safePath = urlPath.replace(/[?#].*$/, '');
  if (safePath.endsWith('/') || safePath === '') safePath += 'index.html';
  const lastSegment = safePath.split('/').pop() || '';
  if (!lastSegment.includes('.')) safePath += '/index.html';
  return join(CACHE_DIR, safePath);
}

function getQueryCachePath(fullUrl: string): string | null {
  const parsed = new URL(fullUrl, TARGET);
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

function isInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'lusion.co' || parsed.hostname === 'www.lusion.co';
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

async function extractLinks(page: Page): Promise<string[]> {
  return page.evaluate((base: string) => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (!href) return;
      try {
        const url = new URL(href, base);
        if (url.hostname === 'lusion.co' || url.hostname === 'www.lusion.co') {
          links.push(url.href);
        }
      } catch {
        // skip
      }
    });
    return [...new Set(links)];
  }, TARGET);
}

async function cachePageThroughProxy(
  context: BrowserContext,
  url: string,
  depth: number,
): Promise<string[]> {
  const page = await context.newPage();
  const discoveredLinks: string[] = [];
  let assetCount = 0;

  // Count cached assets
  page.on('response', (response) => {
    const resUrl = response.url();
    if (resUrl.startsWith(PROXY_URL)) {
      assetCount++;
    }
  });

  try {
    // Navigate through proxy (rewrite URL to go through localhost:3002)
    const proxyUrl = url.replace(TARGET, PROXY_URL);
    console.log(`\n  [D${depth}] ${url}`);
    console.log(`         -> ${proxyUrl}`);

    await page.goto(proxyUrl, {
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
    const links = await extractLinks(page);
    for (const link of links) {
      if (!shouldSkipUrl(link) && isInternalUrl(link)) {
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

async function warmCacheBFS() {
  console.log('='.repeat(60));
  console.log('  Lusion.co Full Crawler (BFS to depth ' + MAX_DEPTH + ')');
  console.log('  Proxy: ' + PROXY_URL);
  console.log('  Cache: ' + CACHE_DIR);
  console.log('='.repeat(60));

  // Check proxy is running
  try {
    const check = await fetch(`${PROXY_URL}/__proxy__/stats`);
    if (!check.ok) throw new Error('Proxy not responding');
    console.log('\n  Proxy is running\n');
  } catch {
    console.error('\n  ERROR: Proxy is not running on ' + PROXY_URL);
    console.error('  Start it first: npx tsx src/proxy/cache-proxy.ts\n');
    process.exit(1);
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

  // BFS queue
  const queue: QueueItem[] = [
    { url: `${TARGET}/`, depth: 0, parentUrl: null },
    { url: `${TARGET}/projects`, depth: 0, parentUrl: null },
  ];
  const visited = new Set<string>();
  let totalPages = 0;
  let totalErrors = 0;
  const depthStats: Record<number, number> = {};

  while (queue.length > 0) {
    const item = queue.shift()!;
    const normalized = normalizeUrl(item.url);

    if (visited.has(normalized)) continue;
    if (item.depth > MAX_DEPTH) continue;

    visited.add(normalized);
    totalPages++;
    depthStats[item.depth] = (depthStats[item.depth] || 0) + 1;

    try {
      const links = await cachePageThroughProxy(context, normalized, item.depth);

      // Add discovered links to queue at depth + 1
      if (item.depth < MAX_DEPTH) {
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

  // Calculate cache size
  const { execSync } = await import('child_process');
  try {
    const size = execSync(`du -sh ${CACHE_DIR} 2>/dev/null || dir /s ${CACHE_DIR} 2>nul`).toString().trim();
    console.log(`  Cache size: ${size}`);
  } catch {
    console.log(`  Cache dir: ${CACHE_DIR}`);
  }

  console.log(`\n  All pages cached! Open http://localhost:3002/ in Chrome`);
  console.log(`  Works offline after caching.\n`);
}

warmCacheBFS().catch((err) => {
  console.error('Crawler failed:', err);
  process.exit(1);
});
