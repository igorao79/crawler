import { createDatabase } from './client.js';
import * as schema from './schema.js';

async function seed() {
  const db = createDatabase();

  // Create initial tables via raw SQL (same as in-memory setup)
  // Drizzle migrations handle this in production, but for dev seed:
  console.log('Seeding database...');

  const jobId = 'seed-job-001';
  await db.insert(schema.crawlJobs).values({
    id: jobId,
    status: 'done',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalPages: 1,
    parsedPages: 1,
    maxDepth: 3,
  });

  const projectId = 'seed-proj-001';
  await db.insert(schema.projects).values({
    id: projectId,
    crawlJobId: jobId,
    slug: 'example-project',
    url: 'https://lusion.co/work/example-project',
    title: 'Example Project',
    description: 'A seed example project',
    tags: JSON.stringify(['web', '3d', 'design']),
    scripts: JSON.stringify(['https://lusion.co/main.js']),
    stylesheets: JSON.stringify(['https://lusion.co/style.css']),
  });

  await db.insert(schema.assets).values({
    id: 'seed-asset-001',
    projectId,
    url: 'https://cdn.lusion.co/hero.jpg',
    type: 'image',
    sizeBytes: 204800,
  });

  console.log('Seed complete.');
}

seed().catch(console.error);
