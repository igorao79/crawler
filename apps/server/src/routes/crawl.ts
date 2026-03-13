import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { Crawler } from '../crawler/engine.js';
import { broadcastProgress } from '../ws/progress.js';
import * as schema from '../db/schema.js';
import type { DrizzleDB } from '../db/client.js';
import { isCreateCrawlJobRequest } from '@lusion-crawler/shared';

// Store active crawlers so we can abort them
const activeCrawlers = new Map<string, Crawler>();

interface CrawlParams {
  id: string;
}

interface CrawlBody {
  maxDepth?: number;
  maxPages?: number;
}

export async function crawlRoutes(fastify: FastifyInstance): Promise<void> {
  const db = fastify.db as DrizzleDB;

  // POST /api/crawl — start a new crawl
  fastify.post('/api/crawl', async (request: FastifyRequest<{ Body: CrawlBody }>, reply: FastifyReply) => {
    const body = request.body ?? {};

    if (!isCreateCrawlJobRequest(body)) {
      return reply.status(400).send({ error: 'validation', message: 'maxDepth must be between 1 and 5' });
    }

    const maxDepth = body.maxDepth ?? 3;
    const maxPages = body.maxPages ?? 0;
    const jobId = uuidv4();

    await db.insert(schema.crawlJobs).values({
      id: jobId,
      status: 'pending',
      maxDepth,
    });

    const crawler = new Crawler(db, jobId, maxDepth, (progress) => {
      broadcastProgress(progress);
    }, maxPages);

    activeCrawlers.set(jobId, crawler);

    // Run in background
    crawler.start().catch((err) => {
      console.error(`[Crawl ${jobId}] Failed:`, err);
    }).finally(() => {
      activeCrawlers.delete(jobId);
    });

    return reply.status(201).send({ id: jobId, status: 'pending' });
  });

  // GET /api/crawl/:id — get crawl status
  fastify.get<{ Params: CrawlParams }>('/api/crawl/:id', async (request, reply) => {
    const { id } = request.params;
    const jobs = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, id));
    const job = jobs[0];

    if (!job) {
      return reply.status(404).send({ error: 'not_found', message: 'Crawl job not found' });
    }

    return reply.send(job);
  });

  // DELETE /api/crawl/:id — abort/delete crawl
  fastify.delete<{ Params: CrawlParams }>('/api/crawl/:id', async (request, reply) => {
    const { id } = request.params;
    const jobs = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, id));
    const job = jobs[0];

    if (!job) {
      return reply.status(404).send({ error: 'not_found', message: 'Crawl job not found' });
    }

    // Abort if running
    const crawler = activeCrawlers.get(id);
    if (crawler) {
      crawler.abort();
      activeCrawlers.delete(id);
    }

    await db
      .update(schema.crawlJobs)
      .set({ status: 'error', error: 'Cancelled by user', finishedAt: new Date().toISOString() })
      .where(eq(schema.crawlJobs.id, id));

    return reply.send({ id, status: 'cancelled' });
  });

  // GET /api/crawl/:id/logs — crawl logs (parsed pages)
  fastify.get<{ Params: CrawlParams }>('/api/crawl/:id/logs', async (request, reply) => {
    const { id } = request.params;
    const pagesList = await db
      .select({ url: schema.pages.url, status: schema.pages.status, depth: schema.pages.depth })
      .from(schema.pages)
      .where(eq(schema.pages.crawlJobId, id));

    return reply.send(pagesList);
  });
}
