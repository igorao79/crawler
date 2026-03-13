import Fastify from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = './proxy-cache';
const TARGET = 'https://lusion.co';
const PORT = 3002;

// Ensure cache dir exists
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function getCachePath(urlPath: string): string {
  // Preserve directory structure from URL path
  let safePath = urlPath.replace(/[?#].*$/, ''); // remove query/hash
  if (safePath.endsWith('/') || safePath === '') safePath += 'index.html';

  // Handle paths with no extension (SPA routes) — save as .html
  const lastSegment = safePath.split('/').pop() || '';
  if (!lastSegment.includes('.')) safePath += '/index.html';

  return join(CACHE_DIR, safePath);
}

function getQueryCachePath(fullUrl: string): string | null {
  const parsed = new URL(fullUrl, TARGET);
  if (!parsed.search) return null;
  // For URLs with query strings, use a hash-based filename
  const hash = createHash('md5').update(fullUrl).digest('hex').slice(0, 12);
  const base = getCachePath(parsed.pathname);
  const dir = dirname(base);
  const ext = base.split('.').pop() || 'bin';
  return join(dir, `_query_${hash}.${ext}`);
}

function getMetaPath(cachePath: string): string {
  return cachePath + '.meta.json';
}

interface CacheMeta {
  contentType: string;
  status: number;
  url: string;
  headers: Record<string, string>;
  cachedAt: string;
}

async function startProxy() {
  const app = Fastify({ logger: false });

  // CORS — allow everything for local dev
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', '*');
    reply.header('Access-Control-Allow-Headers', '*');
    // Remove CSP headers that block local loading
    reply.removeHeader('content-security-policy');
    reply.removeHeader('content-security-policy-report-only');
    done(null, payload);
  });

  // Proxy everything
  app.all('/*', async (request, reply) => {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }

    // Stats endpoint
    if (request.url === '/__proxy__/stats') {
      return reply.send({ target: TARGET, cacheDir: CACHE_DIR, status: 'running' });
    }
    const urlPath = request.url;
    const fullUrl = `${TARGET}${urlPath}`;

    // Check cache first
    const cachePath = urlPath.includes('?')
      ? getQueryCachePath(fullUrl) || getCachePath(urlPath)
      : getCachePath(urlPath);
    const metaPath = getMetaPath(cachePath);

    if (existsSync(cachePath) && existsSync(metaPath)) {
      // Serve from cache
      const meta: CacheMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const body = readFileSync(cachePath);

      let contentType = meta.contentType || 'application/octet-stream';

      // Fix content type for HTML served as SPA routes
      if (cachePath.endsWith('.html')) contentType = 'text/html; charset=utf-8';

      reply.status(meta.status || 200);
      reply.header('content-type', contentType);
      reply.header('x-proxy-cache', 'HIT');

      // Rewrite HTML to fix absolute URLs pointing to lusion.co
      if (contentType.includes('text/html')) {
        let html = body.toString('utf-8');
        html = rewriteHtml(html);
        return reply.send(html);
      }

      // Rewrite CSS url() references
      if (contentType.includes('text/css')) {
        let css = body.toString('utf-8');
        css = rewriteCss(css);
        return reply.send(css);
      }

      // Rewrite JS fetch/import URLs
      if (contentType.includes('javascript')) {
        let js = body.toString('utf-8');
        js = rewriteJs(js);
        return reply.send(js);
      }

      return reply.send(body);
    }

    // Fetch from origin
    try {
      console.log(`[PROXY] FETCH ${fullUrl}`);
      const res = await fetch(fullUrl, {
        method: request.method as string,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': (request.headers['accept'] as string) || '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': TARGET + '/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });

      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await res.arrayBuffer());

      // Cache to disk
      const cacheFileDir = dirname(cachePath);
      if (!existsSync(cacheFileDir)) mkdirSync(cacheFileDir, { recursive: true });

      writeFileSync(cachePath, buffer);

      const meta: CacheMeta = {
        contentType,
        status: res.status,
        url: fullUrl,
        headers: Object.fromEntries(res.headers.entries()),
        cachedAt: new Date().toISOString(),
      };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      reply.status(res.status);
      reply.header('content-type', contentType);
      reply.header('x-proxy-cache', 'MISS');

      // Rewrite HTML
      if (contentType.includes('text/html')) {
        let html = buffer.toString('utf-8');
        html = rewriteHtml(html);
        return reply.send(html);
      }

      if (contentType.includes('text/css')) {
        let css = buffer.toString('utf-8');
        css = rewriteCss(css);
        return reply.send(css);
      }

      if (contentType.includes('javascript')) {
        let js = buffer.toString('utf-8');
        js = rewriteJs(js);
        return reply.send(js);
      }

      return reply.send(buffer);
    } catch (err) {
      console.error(`[PROXY] ERROR ${fullUrl}:`, err instanceof Error ? err.message : err);
      reply.status(502).send({ error: 'Proxy fetch failed', url: fullUrl });
    }
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n🚀 Caching reverse proxy running at http://localhost:${PORT}`);
  console.log(`   Proxying: ${TARGET}`);
  console.log(`   Cache dir: ${CACHE_DIR}`);
  console.log(`\n   Open http://localhost:${PORT}/projects/ in your Chrome browser`);
  console.log(`   First visit fetches from lusion.co and caches locally`);
  console.log(`   Subsequent visits are served from cache (offline)\n`);
}

function stripLusionBranding(code: string): string {
  code = code.replace(/console\.log\s*\([^)]*[Cc]reated\s+by\s+Lusion[^)]*\)\s*;?/g, '');
  code = code.replace(/console\.log\s*\([^)]*lusion\.co[^)]*\)\s*;?/g, '');
  code = code.replace(/console\.log\s*\([^)]*https?:\/\/lusion\.co[^)]*\)\s*;?/g, '');
  code = code.replace(/console\.log\s*\([^)]*["'`]Created by[^)]*Lusion[^)]*\)\s*;?/g, '');
  return code;
}

function rewriteHtml(html: string): string {
  html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  html = stripLusionBranding(html);
  return html;
}

function rewriteCss(css: string): string {
  return css;
}

function rewriteJs(js: string): string {
  return stripLusionBranding(js);
}

startProxy().catch((err) => {
  console.error('Failed to start proxy:', err);
  process.exit(1);
});
