import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

// Use absolute path based on server package root so CWD doesn't matter
const __dirname_resolved = dirname(fileURLToPath(import.meta.url));
const BASE_CACHE_DIR = resolve(__dirname_resolved, '../../proxy-cache');

// Dynamic target — set when a crawl starts, cleared when done
let currentTarget: string | null = null;
// Cookies from browser session — used for authenticated asset fetches
let browserCookies: string | null = null;

export function setProxyTarget(target: string | null): void {
  currentTarget = target;
  externalOrigins = null; // Reset so it re-scans for new target
  console.log(`[Proxy] Target set to: ${target ?? '(none)'}`);
}

export function setProxyCookies(cookies: string | null): void {
  browserCookies = cookies;
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
  // Sanitize Windows-invalid characters in path segments (e.g. "https:" → "https%3A", "&" → "%26")
  safePath = safePath.split('/').map(seg => seg.replace(/:/g, '%3A').replace(/&/g, '%26')).join('/');
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

// Cache of external CDN origins → loaded lazily from .meta.json files
let externalOrigins: Set<string> | null = null;

/** Scan .meta.json files to find external CDN origins that were cached locally */
function getExternalOrigins(): Set<string> {
  if (externalOrigins) return externalOrigins;
  externalOrigins = new Set();
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) return externalOrigins;
  // Walk cache dir and collect unique external hostnames from meta files
  const walk = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.meta.json')) {
          try {
            const meta = JSON.parse(readFileSync(full, 'utf-8'));
            if (meta.hostname && meta.url) {
              const targetHost = currentTarget ? new URL(currentTarget).hostname : '';
              if (meta.hostname !== targetHost) {
                // Extract origin from the full URL
                const parsed = new URL(meta.url);
                externalOrigins!.add(parsed.origin);
              }
            }
          } catch {}
        }
      }
    } catch {}
  };
  walk(cacheDir);
  if (externalOrigins.size > 0) {
    console.log(`[Proxy] External CDN origins for URL rewriting: ${[...externalOrigins].join(', ')}`);
  }
  return externalOrigins;
}

/** Rewrite external CDN URLs to local relative paths */
function rewriteExternalUrls(content: string): string {
  const origins = getExternalOrigins();
  for (const origin of origins) {
    // Replace "https://cdn.example.com/path" with "/path"
    content = content.replaceAll(origin, '');
  }
  return content;
}

function rewriteHtml(html: string): string {
  html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  // Strip SRI integrity attributes — proxied content may differ from origin hashes
  html = html.replace(/\s+integrity=["'][^"']*["']/gi, '');
  // Also strip crossorigin attributes that pair with integrity
  html = html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '');
  // Rewrite external CDN URLs to local paths
  html = rewriteExternalUrls(html);
  return html;
}

function rewriteJs(js: string): string {
  return rewriteExternalUrls(js);
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

  // Check cache — try query-specific cache first, then fall back to base path
  let cachePath: string;
  if (url.includes('?')) {
    const queryPath = getQueryCachePath(fullUrl, target);
    if (queryPath && existsSync(queryPath)) {
      cachePath = queryPath;
    } else {
      cachePath = getCachePath(url);
    }
  } else {
    cachePath = getCachePath(url);
  }

  // If not found, try URL-encoded variant (handles _ipx paths with &, : etc. on Windows)
  if (!existsSync(cachePath)) {
    const encodedUrl = url.split('/').map(seg => {
      try { return encodeURIComponent(decodeURIComponent(seg)); } catch { return seg; }
    }).join('/');
    const encodedPath = getCachePath(encodedUrl);
    if (existsSync(encodedPath)) cachePath = encodedPath;
    // Also try &amp; variant (legacy caches stored with HTML entity encoding)
    if (!existsSync(cachePath)) {
      const ampUrl = url.replace(/&/g, '&amp;');
      const ampEncoded = ampUrl.split('/').map(seg => {
        try { return encodeURIComponent(decodeURIComponent(seg)); } catch { return seg; }
      }).join('/');
      const ampPath = getCachePath(ampEncoded);
      if (existsSync(ampPath)) cachePath = ampPath;
    }
  }

  const metaPath = getMetaPath(cachePath);
  const hasMeta = existsSync(metaPath);

  if (existsSync(cachePath)) {
    const meta: CacheMeta | null = hasMeta ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null;
    const body = readFileSync(cachePath);
    // Determine content type from meta or file extension
    const MIME_MAP: Record<string, string> = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
      '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
      '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
      '.ktx': 'application/octet-stream', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream',
    };
    const ext = cachePath.substring(cachePath.lastIndexOf('.')).toLowerCase();
    let contentType = meta?.contentType || MIME_MAP[ext] || 'application/octet-stream';
    if (cachePath.endsWith('.html')) contentType = 'text/html; charset=utf-8';

    reply.status(meta?.status || 200);
    reply.header('content-type', contentType);
    reply.header('x-proxy-cache', 'HIT');
    reply.removeHeader('content-security-policy');
    reply.removeHeader('set-cookie');

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
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': (request.headers['accept'] as string) || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': target + '/',
    };
    if (browserCookies) {
      fetchHeaders['Cookie'] = browserCookies;
    }
    const res = await fetch(fullUrl, {
      method: request.method as string,
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());

    // Only cache successful responses (2xx/3xx)
    if (res.status < 400) {
      const cacheFileDir = dirname(cachePath);
      if (!existsSync(cacheFileDir)) mkdirSync(cacheFileDir, { recursive: true });
      // Strip SRI integrity from HTML before saving to disk (so ZIP/audit-server also work)
      if (contentType.includes('text/html')) {
        writeFileSync(cachePath, rewriteHtml(buffer.toString('utf-8')));
      } else {
        writeFileSync(cachePath, buffer);
      }
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
    reply.removeHeader('set-cookie');

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
