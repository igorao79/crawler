import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, like, sql } from 'drizzle-orm';
import { existsSync, readdirSync, statSync, readFileSync, createReadStream } from 'fs';
import { join, resolve } from 'path';
import archiver from 'archiver';
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

  // GET /api/source/download-all — ZIP of full site with original structure + deobfuscated JS/CSS
  // Accepts optional ?domain= query parameter for naming the ZIP
  fastify.get<{ Querystring: { domain?: string } }>('/api/source/download-all', async (request, reply) => {
    const PROXY_CACHE_DIR = './proxy-cache';

    if (!existsSync(PROXY_CACHE_DIR)) {
      return reply.status(404).send({ error: 'No cached site found. Run crawl first.' });
    }

    // Use domain from query or fall back to generic name
    const rawDomain = request.query.domain || 'site';
    const safeDomain = rawDomain.replace(/[^a-zA-Z0-9._-]/g, '_');
    const zipFolderName = `${safeDomain}-crawled`;
    const zipFileName = `${safeDomain}-site.zip`;

    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFileName}"`,
      'Transfer-Encoding': 'chunked',
    });

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(reply.raw);

    // Map of proxy-cache relative paths → deobfuscated readable-source paths
    // Only CSS — JS deobfuscation breaks syntax (Prettier can't handle 1.7MB minified bundle)
    const deobfuscatedMap: Record<string, string> = {};
    if (existsSync(join(READABLE_SOURCE_DIR, 'css'))) {
      for (const f of readdirSync(join(READABLE_SOURCE_DIR, 'css'))) {
        if (f === 'design-tokens.css' || f === 'animations.css') continue;
        const originalPath = f.replace(/^_astro_/, '_astro/');
        deobfuscatedMap[originalPath] = join(READABLE_SOURCE_DIR, 'css', f);
      }
    }

    // Walk entire proxy-cache with original structure
    const walkAndAdd = (dir: string, zipPrefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkAndAdd(fullPath, zipPath);
        } else if (!entry.name.endsWith('.meta.json')) {
          // Check if we have a deobfuscated version
          const deobPath = deobfuscatedMap[zipPath];
          if (deobPath && existsSync(deobPath)) {
            archive.file(deobPath, { name: `${zipFolderName}/${zipPath}` });
          } else {
            archive.file(fullPath, { name: `${zipFolderName}/${zipPath}` });
          }
        }
      }
    };

    walkAndAdd(PROXY_CACHE_DIR, '');

    // Also add extra deobfuscated files that don't replace originals
    const extras = [
      { src: join(READABLE_SOURCE_DIR, 'css', 'design-tokens.css'), dest: `${zipFolderName}/_extras/design-tokens.css` },
      { src: join(READABLE_SOURCE_DIR, 'css', 'animations.css'), dest: `${zipFolderName}/_extras/animations.css` },
      { src: join(READABLE_SOURCE_DIR, 'shaders', 'extracted-shaders.glsl'), dest: `${zipFolderName}/_extras/extracted-shaders.glsl` },
      { src: join(READABLE_SOURCE_DIR, 'assets-index', 'ASSETS.md'), dest: `${zipFolderName}/_extras/ASSETS.md` },
    ];
    for (const { src, dest } of extras) {
      if (existsSync(src)) archive.file(src, { name: dest });
    }

    // Add server.cjs for local serving (npx serve doesn't handle SPA routing)
    archive.append(
      `const http = require("http");\n` +
      `const fs = require("fs");\n` +
      `const path = require("path");\n\n` +
      `const PORT = process.env.PORT || 3000;\n` +
      `const ROOT = __dirname;\n\n` +
      `const MIME = {\n` +
      `  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",\n` +
      `  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",\n` +
      `  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",\n` +
      `  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",\n` +
      `  ".ttf": "font/ttf", ".ogg": "audio/ogg", ".mp4": "video/mp4",\n` +
      `  ".webm": "video/webm", ".webp": "image/webp", ".buf": "application/octet-stream",\n` +
      `  ".exr": "application/octet-stream", ".webmanifest": "application/manifest+json",\n` +
      `};\n\n` +
      `http.createServer((req, res) => {\n` +
      `  let url = decodeURIComponent(req.url.split("?")[0]);\n` +
      `  let fp = path.join(ROOT, url);\n` +
      `  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, "index.html");\n` +
      `  if (!fs.existsSync(fp) && !path.extname(fp)) {\n` +
      `    const wi = path.join(fp, "index.html");\n` +
      `    fp = fs.existsSync(wi) ? wi : path.join(ROOT, "index.html");\n` +
      `  }\n` +
      `  if (!fs.existsSync(fp)) { res.writeHead(404); res.end("Not found"); return; }\n` +
      `  const ext = path.extname(fp).toLowerCase();\n` +
      `  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });\n` +
      `  fs.createReadStream(fp).pipe(res);\n` +
      `}).listen(PORT, () => console.log("${safeDomain} site running at http://localhost:" + PORT));\n`,
      { name: `${zipFolderName}/server.cjs` }
    );

    // Add a README with instructions
    archive.append(
      `# ${rawDomain} — Crawled Site\n\n` +
      `## How to run locally\n\n` +
      `1. Extract this ZIP\n` +
      `2. Open terminal in the ${zipFolderName} folder\n` +
      `3. Run: node server.cjs\n` +
      `4. Open http://localhost:3000 in your browser\n\n` +
      `All navigation will work correctly.\n\n` +
      `## What's inside\n\n` +
      `- Full site with original file structure (HTML, CSS, JS, assets)\n` +
      `- _extras/ folder may contain extracted design tokens, animations, and asset catalog\n\n` +
      `## Notes\n\n` +
      `- Some external resources (CDN videos, third-party scripts) may not load offline\n` +
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
