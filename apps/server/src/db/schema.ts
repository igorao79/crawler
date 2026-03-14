import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const crawlJobs = sqliteTable('crawl_jobs', {
  id: text('id').primaryKey(),
  url: text('url').notNull().default('https://lusion.co'),
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  totalPages: integer('total_pages').default(0),
  parsedPages: integer('parsed_pages').default(0),
  maxDepth: integer('max_depth').default(5),
  error: text('error'),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  crawlJobId: text('crawl_job_id').references(() => crawlJobs.id),
  slug: text('slug').notNull(),
  url: text('url').notNull(),
  title: text('title'),
  description: text('description'),
  tags: text('tags'),
  fullHtml: text('full_html'),
  scripts: text('scripts'),
  stylesheets: text('stylesheets'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  url: text('url').notNull(),
  type: text('type').notNull(),
  filePath: text('file_path'),
  sizeBytes: integer('size_bytes'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const pages = sqliteTable('pages', {
  id: text('id').primaryKey(),
  crawlJobId: text('crawl_job_id').references(() => crawlJobs.id),
  projectId: text('project_id').references(() => projects.id),
  url: text('url').notNull(),
  depth: integer('depth').notNull(),
  parentUrl: text('parent_url'),
  fullHtml: text('full_html'),
  title: text('title'),
  status: text('status').default('pending'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});
