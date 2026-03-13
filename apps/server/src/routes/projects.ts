import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, like, sql } from 'drizzle-orm';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import * as schema from '../db/schema.js';
import type { DrizzleDB } from '../db/client.js';

const READABLE_SOURCE_DIR = './readable-source';
const VALID_CATEGORIES = ['js', 'css', 'html', 'shaders', 'assets-index'];

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
            return { name: f, sizeBytes: stat.size };
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
