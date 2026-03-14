import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const BASE_CACHE_DIR = './proxy-cache';

// Dynamic target — set when a crawl starts, cleared when done
let currentTarget: string | null = null;

export function setProxyTarget(target: string | null): void {
  currentTarget = target;
  console.log(`[Proxy] Target set to: ${target ?? '(none)'}`);
}

export function getProxyTarget(): string | null {
  return currentTarget;
}

/** Returns the domain-specific cache directory for the current target */
function getCacheDir(): string {
  if (!currentTarget) return BASE_CACHE_DIR;
  const hostname = new URL(currentTarget).hostname;
  return join(BASE_CACHE_DIR, hostname);
}

/** Returns the domain-specific cache directory for a given domain */
export function getCacheDirForDomain(domain: string): string {
  return join(BASE_CACHE_DIR, domain);
}

// Ensure base cache dir exists
if (!existsSync(BASE_CACHE_DIR)) mkdirSync(BASE_CACHE_DIR, { recursive: true });

function getCachePath(urlPath: string): string {
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  let safePath = urlPath.replace(/[?#].*$/, '');
  if (safePath.endsWith('/') || safePath === '') safePath += 'index.html';
  const lastSegment = safePath.split('/').pop() || '';
  if (!lastSegment.includes('.')) safePath += '/index.html';
  return join(cacheDir, safePath);
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

interface CacheMeta {
  contentType: string;
  status: number;
  url: string;
  headers: Record<string, string>;
  cachedAt: string;
}

function rewriteHtml(html: string): string {
  html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  return html;
}

function rewriteJs(js: string): string {
  return js;
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

  const target = currentTarget;
  if (!target) {
    return reply.status(503).send({ error: 'No proxy target configured', message: 'Start a crawl first to set the proxy target.' });
  }

  // CORS headers
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', '*');
  reply.header('Access-Control-Allow-Headers', '*');

  if (request.method === 'OPTIONS') {
    return reply.status(204).send();
  }

  if (url === '/__proxy__/stats') {
    return reply.send({ target, cacheDir: getCacheDir(), status: 'running' });
  }

  const fullUrl = `${target}${url}`;

  // Check cache
  const cachePath = url.includes('?')
    ? getQueryCachePath(fullUrl, target) || getCachePath(url)
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
        'Referer': target + '/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());

    // Only cache successful responses (2xx/3xx)
    if (res.status < 400) {
      const cacheFileDir = dirname(cachePath);
      if (!existsSync(cacheFileDir)) mkdirSync(cacheFileDir, { recursive: true });
      writeFileSync(cachePath, buffer);
    } else {
      console.warn(`[PROXY] Not caching ${fullUrl} (status ${res.status})`);
    }

    if (res.status < 400) {
      const meta: CacheMeta = {
        contentType,
        status: res.status,
        url: fullUrl,
        headers: Object.fromEntries(res.headers.entries()),
        cachedAt: new Date().toISOString(),
      };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

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
