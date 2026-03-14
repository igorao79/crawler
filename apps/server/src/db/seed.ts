import { createDatabase } from './client.js';
import * as schema from './schema.js';
import { sql } from 'drizzle-orm';

const PROJECTS = [
  {
    slug: 'devin_ai',
    title: 'Devin AI',
    description: 'We worked with Cognition AI to create a website for their AI-powered platform Devin AI. The website needed to be sleek and modern, with a focus on showcasing the platform\'s features and benefits.',
    tags: ['Concept', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'porsche_dream_machine',
    title: 'Porsche: Dream Machine',
    description: 'An immersive 3D experience for Porsche, blending automotive design with cutting-edge web technology and cinematic storytelling.',
    tags: ['Concept', '3D Design', 'Motion Design', 'Compositing'],
  },
  {
    slug: 'choo_choo_world',
    title: 'Choo Choo World',
    description: 'A playful and interactive game-like web experience. We designed and developed a vibrant 3D world with engaging gameplay mechanics.',
    tags: ['Concept', 'Game Design', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'worldcoin',
    title: 'Worldcoin Globe',
    description: 'A stunning WebGL globe visualization for Worldcoin, showcasing their global network with real-time 3D data rendering.',
    tags: ['API Design', '3D Design', 'WebGL'],
  },
  {
    slug: 'spatial_fusion',
    title: 'Meta: Spatial Fusion',
    description: 'An experimental WebXR experience for Meta, pushing the boundaries of spatial computing and immersive web technologies.',
    tags: ['Web Design', 'Web Development', 'WebGL', 'WebXR'],
  },
  {
    slug: 'synthetic_human',
    title: 'Synthetic Human',
    description: 'A groundbreaking real-time 3D human rendering experiment, exploring the uncanny valley with advanced shaders and animation.',
    tags: ['Creative Coding', 'Animation', 'Frontend development', '3D Visual optimization'],
  },
  {
    slug: 'spaace',
    title: 'Spaace - NFT Marketplace',
    description: 'A visually striking NFT marketplace with immersive 3D elements and smooth WebGL transitions throughout the experience.',
    tags: ['Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'infinite_passerella',
    title: 'Infinite Passerella',
    description: 'An endless virtual runway experience combining fashion and technology with real-time 3D rendering and interactive design.',
    tags: ['Concept', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'zero_tech',
    title: 'Zero Tech',
    description: 'A futuristic web experience for Zero Tech, featuring cutting-edge WebGL visuals and innovative interaction design.',
    tags: ['Concept', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'soda_experience',
    title: 'Soda Experience',
    description: 'An interactive WebAR and WebGL experience that brings a soda brand to life with optimized 3D visuals and augmented reality.',
    tags: ['3D Optimization', 'WebGL', 'WebAR'],
  },
  {
    slug: 'my_little_story_book',
    title: 'My Little Storybook',
    description: 'A charming interactive storybook experience with beautifully crafted 3D scenes and engaging narrative-driven interactions.',
    tags: ['Concept', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'the_turn_of_the_screw',
    title: 'The Turn Of The Screw',
    description: 'An atmospheric and haunting web experience inspired by the classic novella, featuring dark 3D environments and immersive storytelling.',
    tags: ['Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'lusion_labs',
    title: 'Lusion Labs',
    description: 'Our experimental playground — a collection of WebGL experiments, creative coding demos, and R&D projects pushing web boundaries.',
    tags: ['Concept', 'Web Design', 'Web Development', '3D Design', 'WebGL'],
  },
  {
    slug: 'maxmara_bearings_gifts',
    title: 'Max Mara: Bearing Gifts',
    description: 'A luxurious WebGL experience for Max Mara\'s holiday campaign, featuring elegant 3D product showcases and festive interactivity.',
    tags: ['WebGL'],
  },
  {
    slug: 'ddd_2024',
    title: 'DDD 2024',
    description: 'A dynamic event website for DDD 2024, featuring creative coding, rich animations, and cutting-edge 3D visual design.',
    tags: ['UI/UX design', '3D Visual design', 'Creative Coding', 'Frontend development', 'Animation'],
  },
];

async function seed() {
  const db = createDatabase();

  console.log('Clearing existing data...');
  db.run(sql`DELETE FROM assets`);
  db.run(sql`DELETE FROM pages`);
  db.run(sql`DELETE FROM projects`);
  db.run(sql`DELETE FROM crawl_jobs`);

  console.log('Seeding 15 projects from lusion.co...');

  const jobId = 'crawl-lusion-001';
  await db.insert(schema.crawlJobs).values({
    id: jobId,
    url: 'https://lusion.co',
    status: 'done',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalPages: 18,
    parsedPages: 18,
    maxDepth: 5,
  });

  for (let i = 0; i < PROJECTS.length; i++) {
    const p = PROJECTS[i];
    const projectId = `proj-${p.slug}`;

    await db.insert(schema.projects).values({
      id: projectId,
      crawlJobId: jobId,
      slug: p.slug,
      url: `https://lusion.co/projects/${p.slug}`,
      title: p.title,
      description: p.description,
      tags: JSON.stringify(p.tags),
      scripts: JSON.stringify([`/_astro/hoisted.81170750.js`]),
      stylesheets: JSON.stringify([`/_astro/about.e7252178.css`]),
    });

    // Add page entry
    await db.insert(schema.pages).values({
      id: `page-${p.slug}`,
      crawlJobId: jobId,
      projectId,
      url: `https://lusion.co/projects/${p.slug}/`,
      depth: 2,
      parentUrl: 'https://lusion.co/projects/',
      title: `Lusion - ${p.title}`,
      status: 'done',
    });

    console.log(`  ✓ ${p.title}`);
  }

  console.log(`\nSeed complete: ${PROJECTS.length} projects created.`);
}

seed().catch(console.error);
