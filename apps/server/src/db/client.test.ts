import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDatabase, type DrizzleDB } from './client.js';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';

describe('Database operations', () => {
  let db: DrizzleDB;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  describe('crawl_jobs', () => {
    it('creates and reads a crawl job', async () => {
      await db.insert(schema.crawlJobs).values({
        id: 'job-1',
        status: 'pending',
        maxDepth: 3,
      });

      const jobs = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, 'job-1'));
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('job-1');
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].maxDepth).toBe(3);
    });

    it('updates crawl job status', async () => {
      await db.insert(schema.crawlJobs).values({ id: 'job-2', status: 'pending' });
      await db.update(schema.crawlJobs).set({ status: 'running' }).where(eq(schema.crawlJobs.id, 'job-2'));

      const jobs = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, 'job-2'));
      expect(jobs[0].status).toBe('running');
    });
  });

  describe('projects', () => {
    it('inserts project with JSON fields', async () => {
      await db.insert(schema.crawlJobs).values({ id: 'job-p', status: 'done' });

      await db.insert(schema.projects).values({
        id: 'proj-1',
        crawlJobId: 'job-p',
        slug: 'test-project',
        url: 'https://lusion.co/work/test-project',
        title: 'Test Project',
        description: 'A test project',
        tags: JSON.stringify(['web', '3d']),
        scripts: JSON.stringify(['https://cdn.lusion.co/main.js']),
        stylesheets: JSON.stringify(['https://cdn.lusion.co/style.css']),
      });

      const projects = await db.select().from(schema.projects).where(eq(schema.projects.slug, 'test-project'));
      expect(projects).toHaveLength(1);

      const p = projects[0];
      expect(p.title).toBe('Test Project');
      const tags: string[] = JSON.parse(p.tags ?? '[]');
      expect(tags).toEqual(['web', '3d']);
    });
  });

  describe('assets', () => {
    it('inserts assets linked to project', async () => {
      await db.insert(schema.crawlJobs).values({ id: 'job-a', status: 'done' });
      await db.insert(schema.projects).values({
        id: 'proj-a',
        crawlJobId: 'job-a',
        slug: 'proj-a',
        url: 'https://lusion.co/work/proj-a',
      });

      await db.insert(schema.assets).values({
        id: 'asset-1',
        projectId: 'proj-a',
        url: 'https://cdn.lusion.co/img.jpg',
        type: 'image',
        sizeBytes: 1024,
      });

      const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, 'proj-a'));
      expect(assets).toHaveLength(1);
      expect(assets[0].type).toBe('image');
      expect(assets[0].sizeBytes).toBe(1024);
    });
  });

  describe('pages', () => {
    it('inserts pages linked to crawl job', async () => {
      await db.insert(schema.crawlJobs).values({ id: 'job-pg', status: 'done' });

      await db.insert(schema.pages).values({
        id: 'page-1',
        crawlJobId: 'job-pg',
        url: 'https://lusion.co/about',
        depth: 2,
        parentUrl: 'https://lusion.co',
        status: 'parsed',
      });

      const pagesList = await db.select().from(schema.pages).where(eq(schema.pages.crawlJobId, 'job-pg'));
      expect(pagesList).toHaveLength(1);
      expect(pagesList[0].depth).toBe(2);
      expect(pagesList[0].status).toBe('parsed');
    });
  });
});
