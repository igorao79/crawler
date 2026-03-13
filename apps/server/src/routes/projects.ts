import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { DrizzleDB } from '../db/client.js';

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
