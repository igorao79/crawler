import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = './proxy-cache';
const TARGET = 'https://lusion.co';

// Ensure cache dir exists
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

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

interface CacheMeta {
  contentType: string;
  status: number;
  url: string;
  headers: Record<string, string>;
  cachedAt: string;
}

function rewriteHtml(html: string): string {
  html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  html = stripLusionBranding(html);
  return html;
}

function rewriteJs(js: string): string {
  return stripLusionBranding(js);
}

function stripLusionBranding(code: string): string {
  // Replace with void 0 (not empty string) to avoid syntax errors in comma expressions
  // e.g. (console.clear(),console.log("Created by Lusion")) → (console.clear(),void 0)
  code = code.replace(/console\.log\s*\([^)]*[Cc]reated\s+by\s+Lusion[^)]*\)/g, 'void 0');
  code = code.replace(/console\.log\s*\([^)]*lusion\.co[^)]*\)/g, 'void 0');
  code = code.replace(/console\.log\s*\([^)]*https?:\/\/lusion\.co[^)]*\)/g, 'void 0');
  code = code.replace(/console\.log\s*\([^)]*["'`]Created by[^)]*Lusion[^)]*\)/g, 'void 0');
  // Also neutralize console.clear that often accompanies the branding
  code = code.replace(/console\.clear\s*\(\s*\)\s*&&\s*console\.clear\s*\(\s*\)\s*,\s*void 0/g, 'void 0');
  return code;
}

/**
 * Handle proxy request — exported so it can be used as notFoundHandler
 */
export async function handleProxyRequest(request: FastifyRequest, reply: FastifyReply) {
  const url = request.url;

  // Don't proxy API/WS/preview routes — return real 404
  if (url.startsWith('/api/') || url.startsWith('/ws/') || url.startsWith('/preview/')) {
    return reply.status(404).send({ error: 'Not Found', message: `Route ${request.method}:${url} not found` });
  }

  // CORS headers
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', '*');
  reply.header('Access-Control-Allow-Headers', '*');

  if (request.method === 'OPTIONS') {
    return reply.status(204).send();
  }

  if (url === '/__proxy__/stats') {
    return reply.send({ target: TARGET, cacheDir: CACHE_DIR, status: 'running' });
  }

  const fullUrl = `${TARGET}${url}`;

  // Check cache
  const cachePath = url.includes('?')
    ? getQueryCachePath(fullUrl) || getCachePath(url)
    : getCachePath(url);
  const metaPath = getMetaPath(cachePath);

  if (existsSync(cachePath) && existsSync(metaPath)) {
    const meta: CacheMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const body = readFileSync(cachePath);
    let contentType = meta.contentType || 'application/octet-stream';
    if (cachePath.endsWith('.html')) contentType = 'text/html; charset=utf-8';

    reply.status(meta.status || 200);
    reply.header('content-type', contentType);
    reply.header('x-proxy-cache', 'HIT');
    reply.removeHeader('content-security-policy');

    if (contentType.includes('text/html')) {
      return reply.send(rewriteHtml(body.toString('utf-8')));
    }
    if (contentType.includes('javascript')) {
      return reply.send(rewriteJs(body.toString('utf-8')));
    }
    return reply.send(body);
  }

  // Fetch from origin
  try {
    console.log(`[PROXY] FETCH ${fullUrl}`);
    const res = await fetch(fullUrl, {
      method: request.method as string,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
    reply.removeHeader('content-security-policy');

    if (contentType.includes('text/html')) {
      return reply.send(rewriteHtml(buffer.toString('utf-8')));
    }
    if (contentType.includes('javascript')) {
      return reply.send(rewriteJs(buffer.toString('utf-8')));
    }
    return reply.send(buffer);
  } catch (err) {
    console.error(`[PROXY] ERROR ${fullUrl}:`, err instanceof Error ? err.message : err);
    reply.status(502).send({ error: 'Proxy fetch failed', url: fullUrl });
  }
}

/**
 * Fastify plugin — no-op now. Use handleProxyRequest with setNotFoundHandler instead.
 */
export async function proxyPlugin(_app: FastifyInstance) {
  // Proxy is now handled via setNotFoundHandler in server.ts
}
