import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, like, sql } from 'drizzle-orm';
import { existsSync, readdirSync, statSync, readFileSync, createReadStream } from 'fs';
import { join, resolve, extname } from 'path';
import archiver from 'archiver';
import * as prettier from 'prettier';
import * as schema from '../db/schema.js';
import type { DrizzleDB } from '../db/client.js';
import { aiDeobfuscateFile, listJsFiles } from '../proxy/ai-deobfuscate.js';

const READABLE_SOURCE_DIR = './readable-source';
const VALID_CATEGORIES = ['js', 'css', 'html', 'shaders', 'assets-index', 'ai-deobfuscated'];

interface ProjectParams {
  slug: string;
}

interface ProjectQuery {
  page?: string;
  pageSize?: string;
  tag?: string;
  search?: string;
}

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  const db = fastify.db as DrizzleDB;

  // GET /api/projects — list projects with pagination and filters
  fastify.get<{ Querystring: ProjectQuery }>('/api/projects', async (request, reply) => {
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? '20', 10) || 20));
    const tag = request.query.tag;
    const search = request.query.search;
    const offset = (page - 1) * pageSize;

    let query = db
      .select({
        id: schema.projects.id,
        slug: schema.projects.slug,
        url: schema.projects.url,
        title: schema.projects.title,
        description: schema.projects.description,
        tags: schema.projects.tags,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects);

    // Drizzle doesn't have a clean way to dynamically chain where clauses,
    // so we build conditions array
    const conditions = [];

    if (tag) {
      conditions.push(like(schema.projects.tags, `%"${tag}"%`));
    }

    if (search) {
      conditions.push(like(schema.projects.title, `%${search}%`));
    }

    // Apply conditions
    let filteredQuery;
    if (conditions.length === 1) {
      filteredQuery = query.where(conditions[0]);
    } else if (conditions.length === 2) {
      filteredQuery = query.where(sql`${conditions[0]} AND ${conditions[1]}`);
    } else {
      filteredQuery = query;
    }

    const allResults = await filteredQuery;
    const total = allResults.length;
    const paginatedResults = allResults.slice(offset, offset + pageSize);

    // Parse tags from JSON string
    const data = paginatedResults.map((p) => ({
      ...p,
      tags: parseJsonArray(p.tags),
    }));

    return reply.send({ data, total, page, pageSize });
  });

  // GET /api/projects/:slug — project detail with assets and pages
  fastify.get<{ Params: ProjectParams }>('/api/projects/:slug', async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
    const { slug } = request.params;

    const projectResults = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.slug, slug));

    const project = projectResults[0];
    if (!project) {
      return reply.status(404).send({ error: 'not_found', message: 'Project not found' });
    }

    const projectAssets = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.projectId, project.id));

    const projectPages = await db
      .select()
      .from(schema.pages)
      .where(eq(schema.pages.projectId, project.id));

    return reply.send({
      ...project,
      tags: parseJsonArray(project.tags),
      scripts: parseJsonArray(project.scripts),
      stylesheets: parseJsonArray(project.stylesheets),
      assets: projectAssets,
      pages: projectPages,
    });
  });

  // GET /api/source/tree — file tree of deobfuscated source
  fastify.get('/api/source/tree', async (_request, reply) => {
    if (!existsSync(READABLE_SOURCE_DIR)) {
      return reply.send({ categories: [] });
    }

    const categories = VALID_CATEGORIES
      .filter((cat) => existsSync(join(READABLE_SOURCE_DIR, cat)))
      .map((cat) => {
        const dir = join(READABLE_SOURCE_DIR, cat);
        const files = readdirSync(dir)
          .filter((f) => !f.endsWith('.meta.json'))
          .map((f) => {
            const stat = statSync(join(dir, f));
            return { name: f, displayName: friendlyFileName(f, cat), sizeBytes: stat.size };
          })
          .sort((a, b) => b.sizeBytes - a.sizeBytes);
        return { name: cat, files };
      });

    return reply.send({ categories });
  });

  // GET /api/source/file — raw text content of a deobfuscated file
  fastify.get<{
    Querystring: { category?: string; name?: string; download?: string };
  }>('/api/source/file', async (request, reply) => {
    const { category, name, download } = request.query;

    if (!category || !name) {
      return reply.status(400).send({ error: 'category and name are required' });
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return reply.status(400).send({ error: 'invalid category' });
    }

    // Path traversal protection
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return reply.status(400).send({ error: 'invalid filename' });
    }

    const filePath = resolve(READABLE_SOURCE_DIR, category, name);
    const safeBase = resolve(READABLE_SOURCE_DIR);
    if (!filePath.startsWith(safeBase)) {
      return reply.status(400).send({ error: 'invalid path' });
    }

    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'file not found' });
    }

    const content = readFileSync(filePath, 'utf-8');

    if (download === 'true') {
      reply.header('Content-Disposition', `attachment; filename="${name}"`);
    } else {
      reply.header('Content-Disposition', 'inline');
    }

    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(content);
  });

  // GET /api/source/assets — parsed asset index from ASSETS.md
  fastify.get('/api/source/assets', async (_request, reply) => {
    const assetsPath = join(READABLE_SOURCE_DIR, 'assets-index', 'ASSETS.md');
    if (!existsSync(assetsPath)) {
      return reply.send({ categories: [], total: 0 });
    }

    const content = readFileSync(assetsPath, 'utf-8');
    const categories: { name: string; count: number; items: { path: string; ext: string }[] }[] = [];
    let currentCategory: (typeof categories)[0] | null = null;

    for (const line of content.split('\n')) {
      const headerMatch = line.match(/^## (.+?) \((\d+)\)/);
      if (headerMatch) {
        currentCategory = { name: headerMatch[1], count: parseInt(headerMatch[2]), items: [] };
        categories.push(currentCategory);
        continue;
      }
      if (currentCategory && line.startsWith('- ')) {
        const path = line.slice(2).trim().replace(/\\/g, '/');
        const ext = path.split('.').pop() || '';
        currentCategory.items.push({ path, ext });
      }
    }

    const total = categories.reduce((sum, c) => sum + c.items.length, 0);
    return reply.send({ categories, total });
  });

  // GET /api/source/ai-files — list JS files available for AI deobfuscation
  fastify.get('/api/source/ai-files', async (_request, reply) => {
    const files = listJsFiles();
    return reply.send({ files });
  });

  // POST /api/source/deobfuscate — run AI deobfuscation on a JS file
  fastify.post<{
    Body: { fileName: string };
  }>('/api/source/deobfuscate', async (request, reply) => {
    const { fileName } = request.body ?? {};

    if (!fileName || typeof fileName !== 'string') {
      return reply.status(400).send({ error: 'fileName is required' });
    }

    // Validate filename (no path traversal)
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return reply.status(400).send({ error: 'invalid filename' });
    }

    if (!process.env.GEMINI_API_KEY && !process.env.CEREBRAS_API_KEY && !process.env.GROQ_API_KEY) {
      return reply.status(500).send({ error: 'Set GEMINI_API_KEY, CEREBRAS_API_KEY, or GROQ_API_KEY' });
    }

    // Stream progress as newline-delimited JSON
    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });

    try {
      const result = await aiDeobfuscateFile(fileName, (progress) => {
        reply.raw.write(JSON.stringify(progress) + '\n');
      });

      reply.raw.write(
        JSON.stringify({
          totalChunks: result.chunks,
          currentChunk: result.chunks,
          fileName,
          status: 'done',
          message: `Saved to ${result.outputPath}`,
        }) + '\n',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      reply.raw.write(
        JSON.stringify({
          totalChunks: 0,
          currentChunk: 0,
          fileName,
          status: 'error',
          message: errMsg,
        }) + '\n',
      );
    }

    reply.raw.end();
    return reply;
  });

  // GET /api/source/download-all — ZIP of crawled site from proxy-cache/{domain}/
  // Uses proxy cache which preserves original site structure
  fastify.get<{ Querystring: { domain?: string; url?: string } }>('/api/source/download-all', async (request, reply) => {
    const rawDomain = request.query.domain || 'site';
    const originalUrl = request.query.url || '';
    const safeDomain = rawDomain.replace(/[^a-zA-Z0-9._-]/g, '_');
    const zipFolderName = `${safeDomain}-crawled`;
    const zipFileName = `${safeDomain}-site.zip`;

    // Use domain-specific proxy cache (original site structure)
    const { getCacheDirForDomain } = await import('../proxy/proxy-plugin.js');
    const cacheDir = getCacheDirForDomain(rawDomain);

    if (!existsSync(cacheDir)) {
      return reply.status(404).send({ error: `No cached site found for ${rawDomain}. Run crawl first.` });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFileName}"`,
      'Transfer-Encoding': 'chunked',
    });

    const archive = archiver('zip', { zlib: { level: 3 } }); // level 3 = faster, ~5% bigger
    archive.pipe(reply.raw);

    // Pre-compressed formats — skip zlib compression (store as-is)
    const STORE_EXTS = new Set([
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico',
      '.mp4', '.webm', '.ogg', '.mp3', '.wav',
      '.woff2', '.woff',
      '.glb', '.ktx', '.ktx2', '.basis', '.hdr',
    ]);

    // Walk proxy-cache with original site structure, prettify HTML/CSS/JS
    const PRETTIFY_EXTS = new Set(['.html', '.css', '.js', '.mjs']);
    const PRETTIER_PARSERS: Record<string, string> = {
      '.html': 'html',
      '.css': 'css',
      '.js': 'babel',
      '.mjs': 'babel',
    };

    // Rewrite absolute URLs to the original domain → relative paths for local serving
    const rewriteAbsoluteUrls = (content: string, domain: string): string => {
      // Replace https://domain/path and http://domain/path with /path
      const patterns = [
        new RegExp(`https?://${domain.replace(/\./g, '\\.')}(/[^"'\\s)>]*)`, 'gi'),
        new RegExp(`https?://${domain.replace(/\./g, '\\.')}(["'\\s)>])`, 'gi'),
      ];
      let result = content;
      // Full URLs with path: https://domain/path → /path
      result = result.replace(patterns[0], '$1');
      // Domain-only URLs: https://domain" → /"
      result = result.replace(patterns[1], '/$1');
      return result;
    };

    const walkAndAdd = async (dir: string, zipPrefix: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          // Skip npm package directories (e.g. zone.js/dist/)
          if (/^\w[\w.-]*\.\w+$/.test(entry.name) && !entry.name.startsWith('_')) continue;
          await walkAndAdd(fullPath, zipPath);
        } else if (!entry.name.endsWith('.meta.json')) {
          const ext = extname(entry.name).toLowerCase();
          const fileSize = statSync(fullPath).size;

          // Skip files without extensions (likely SPA fallback pages like "Logartis", "summary_large_image")
          if (!ext && entry.name !== 'LICENSE' && entry.name !== 'CNAME') continue;

          // Skip npm package paths (e.g. zone.js/dist/) that were fetched as SPA fallback
          const relPath = fullPath.substring(cacheDir.length).replace(/\\/g, '/');
          if (/^\/?\w[\w.-]*\.\w+\//.test(relPath) && !/^\/?_/.test(relPath) && !/^\/?assets/i.test(relPath)) continue;

          // Skip non-HTML files that are actually HTML (SPA fallback responses)
          if (ext && ext !== '.html' && ext !== '.htm' && fileSize < 20_000) {
            try {
              const head = readFileSync(fullPath, 'utf-8').trimStart().substring(0, 50);
              if (head.startsWith('<!DOCTYPE html') || head.startsWith('<html')) continue;
            } catch { /* binary file, skip check */ }
          }
          const isTextFile = PRETTIFY_EXTS.has(ext) || ext === '.json' || ext === '.webmanifest';

          // For text files: rewrite absolute domain URLs to relative
          if (isTextFile && fileSize < 5_000_000) {
            try {
              let content = readFileSync(fullPath, 'utf-8');
              content = rewriteAbsoluteUrls(content, rawDomain);

              // Prettify small files
              if (PRETTIFY_EXTS.has(ext) && fileSize < 512_000) {
                try {
                  content = await prettier.format(content, {
                    parser: PRETTIER_PARSERS[ext] || 'babel',
                    printWidth: 100,
                    tabWidth: 2,
                    singleQuote: true,
                  });
                } catch { /* use rewritten but unformatted */ }
              }
              archive.append(content, { name: `${zipFolderName}/${zipPath}` });
            } catch {
              archive.file(fullPath, { name: `${zipFolderName}/${zipPath}` });
            }
          } else {
            // Skip compression for already-compressed formats (images, video, audio, 3D)
            archive.file(fullPath, {
              name: `${zipFolderName}/${zipPath}`,
              store: STORE_EXTS.has(ext),
            });
          }
        }
      }
    };

    await walkAndAdd(cacheDir, '');

    // Determine first page from the original crawl URL
    let firstHtmlPath = '/';
    if (originalUrl) {
      try {
        const parsed = new URL(originalUrl);
        firstHtmlPath = parsed.pathname || '/';
      } catch { /* use default */ }
    }

    // Verify that firstHtmlPath actually has an index.html — if not, search for one
    const firstHtmlFile = join(cacheDir, firstHtmlPath, 'index.html');
    const firstHtmlDirect = join(cacheDir, firstHtmlPath);
    const hasRootIndex = existsSync(firstHtmlFile) ||
      (firstHtmlPath !== '/' && existsSync(firstHtmlDirect) && firstHtmlDirect.endsWith('.html'));

    if (!hasRootIndex) {
      // Search for the first index.html in the cache
      const findFirstHtml = (dir: string, prefix: string): boolean => {
        if (!existsSync(dir)) return false;
        // Check current dir first
        if (existsSync(join(dir, 'index.html'))) {
          firstHtmlPath = prefix ? `/${prefix}/` : '/';
          return true;
        }
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (findFirstHtml(join(dir, entry.name), sub)) return true;
          }
        }
        return false;
      };
      findFirstHtml(cacheDir, '');
    }

    // Add server.cjs for local serving
    archive.append(
      `const http = require("http");\n` +
      `const fs = require("fs");\n` +
      `const path = require("path");\n\n` +
      `const PORT = process.env.PORT || 5555;\n` +
      `const ROOT = __dirname;\n` +
      `const FIRST_PAGE = "${firstHtmlPath || '/'}";\n\n` +
      `const MIME = {\n` +
      `  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",\n` +
      `  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",\n` +
      `  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",\n` +
      `  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",\n` +
      `  ".ttf": "font/ttf", ".ogg": "audio/ogg", ".mp4": "video/mp4",\n` +
      `  ".webm": "video/webm", ".webp": "image/webp", ".buf": "application/octet-stream",\n` +
      `  ".exr": "application/octet-stream", ".webmanifest": "application/manifest+json",\n` +
      `  ".ktx": "image/ktx", ".ktx2": "image/ktx2", ".gltf": "model/gltf+json",\n` +
      `  ".glb": "model/gltf-binary", ".hdr": "application/octet-stream", ".basis": "application/octet-stream",\n` +
      `};\n\n` +
      `// Helper: resolve file path trying both decoded and encoded variants\n` +
      `function resolve(url) {\n` +
      `  const decoded = decodeURIComponent(url);\n` +
      `  const raw = url; // keep %20 etc as-is\n` +
      `  // Try decoded first, then raw (files may be saved with %20 in name)\n` +
      `  for (const u of [decoded, raw]) {\n` +
      `    let fp = path.join(ROOT, u);\n` +
      `    if (fs.existsSync(fp)) return { fp, url: u };\n` +
      `    // Try with index.html for directories\n` +
      `    const wi = path.join(fp, "index.html");\n` +
      `    if (fs.existsSync(wi)) return { fp: wi, url: u };\n` +
      `  }\n` +
      `  return { fp: path.join(ROOT, decoded), url: decoded };\n` +
      `}\n\n` +
      `http.createServer((req, res) => {\n` +
      `  const rawUrl = req.url.split("?")[0];\n` +
      `  // Redirect root to first available page\n` +
      `  if (rawUrl === "/" && FIRST_PAGE !== "/") {\n` +
      `    res.writeHead(302, { Location: FIRST_PAGE });\n` +
      `    res.end();\n` +
      `    return;\n` +
      `  }\n` +
      `  const { fp: resolved } = resolve(rawUrl);\n` +
      `  let fp = resolved;\n` +
      `  // Redirect directories to trailing slash (fixes relative paths in HTML)\n` +
      `  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory() && !rawUrl.endsWith("/")) {\n` +
      `    res.writeHead(301, { Location: rawUrl + "/" });\n` +
      `    res.end();\n` +
      `    return;\n` +
      `  }\n` +
      `  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, "index.html");\n` +
      `  if (!fs.existsSync(fp) && !path.extname(fp)) {\n` +
      `    const wi = path.join(fp, "index.html");\n` +
      `    fp = fs.existsSync(wi) ? wi : path.join(ROOT, "index.html");\n` +
      `  }\n` +
      `  if (!fs.existsSync(fp)) { res.writeHead(404); res.end("Not found"); return; }\n` +
      `  const ext = path.extname(fp).toLowerCase();\n` +
      `  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });\n` +
      `  fs.createReadStream(fp).pipe(res);\n` +
      `}).listen(PORT, () => console.log("${safeDomain} running at http://localhost:" + PORT));\n`,
      { name: `${zipFolderName}/server.cjs` }
    );

    // Add README
    archive.append(
      `# ${rawDomain} — Crawled Site\n\n` +
      `## How to run locally\n\n` +
      `1. Extract this ZIP\n` +
      `2. Open terminal in the ${zipFolderName} folder\n` +
      `3. Run: node server.cjs\n` +
      `4. Open http://localhost:5555 in your browser\n\n` +
      `## What's inside\n\n` +
      `- Full site with original file structure (HTML, CSS, JS, assets)\n\n` +
      `## Notes\n\n` +
      `- Some external resources (CDN, third-party scripts) may not load offline\n` +
      `- Requires Node.js installed\n`,
      { name: `${zipFolderName}/README.md` }
    );

    await archive.finalize();
    return reply;
  });
}

/** Maps ugly build-hashed filenames to human-readable display names */
function friendlyFileName(raw: string, category: string): string {
  // HTML pages — turn "projects_devin_ai_index.html" → "devin-ai.html"
  if (category === 'html') {
    if (raw === 'index.html') return 'index.html';
    if (raw === 'about_index.html') return 'about.html';
    if (raw === 'projects_index.html') return 'projects.html';
    // projects_devin_ai_index.html → devin-ai.html
    const m = raw.match(/^projects_(.+?)_index\.html$/);
    if (m) {
      return m[1].replace(/_/g, '-') + '.html';
    }
  }

  // JS — strip astro hashes
  if (category === 'js') {
    if (raw.match(/astro_hoisted/i)) return 'main-bundle.js';
    if (raw.match(/team/i)) return 'team-data.json';
    if (raw.match(/webmanifest/i)) return 'site.webmanifest';
  }

  // CSS — strip astro hashes
  if (category === 'css') {
    if (raw.match(/astro_about/i)) return 'styles.css';
    if (raw === 'design-tokens.css') return 'design-tokens.css';
    if (raw === 'animations.css') return 'animations.css';
  }

  // Shaders
  if (category === 'shaders') {
    if (raw === 'extracted-shaders.glsl') return 'all-shaders.glsl';
  }

  // Assets index
  if (category === 'assets-index') {
    if (raw === 'ASSETS.md') return 'Asset Catalog';
  }

  return raw;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}
