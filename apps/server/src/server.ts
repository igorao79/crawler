import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { getDatabase } from './db/client.js';
import { crawlRoutes } from './routes/crawl.js';
import { projectRoutes } from './routes/projects.js';
import { addClient } from './ws/progress.js';
import { proxyPlugin } from './proxy/proxy-plugin.js';
import type { DrizzleDB } from './db/client.js';

// Extend Fastify type to include db
declare module 'fastify' {
  interface FastifyInstance {
    db: DrizzleDB;
  }
}

async function buildServer() {
  const fastify = Fastify({ logger: true });

  // Database
  const db = getDatabase();
  fastify.decorate('db', db);

  // CORS — allow configured origins or default to localhost
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:3000', 'http://localhost:3001'];

  await fastify.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
  });

  // WebSocket
  await fastify.register(websocket);

  // WebSocket route for crawl progress
  fastify.register(async function (instance) {
    instance.get('/ws/crawl/:id', { websocket: true }, (socket, request) => {
      const params = request.params as { id: string };
      addClient(params.id, socket);
    });
  });

  // Serve downloaded project files at /preview/<slug>/...
  await fastify.register(fastifyStatic, {
    root: resolve('./output'),
    prefix: '/preview/',
    decorateReply: false,
  });

  // REST routes
  await fastify.register(crawlRoutes);
  await fastify.register(projectRoutes);

  // Static preview — serves HTML with scripts stripped so SPA doesn't redirect
  fastify.get<{ Params: { slug: string } }>('/api/preview/:slug', async (request, reply) => {
    const { slug } = request.params;
    const htmlPath = resolve(`./output/${slug}/index.html`);
    if (!existsSync(htmlPath)) {
      return reply.status(404).send({ error: 'not_found' });
    }
    let html = readFileSync(htmlPath, 'utf-8');
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/href="css\//g, `href="/preview/${slug}/css/`);
    html = html.replace(/href="\.\/assets\//g, `href="/preview/${slug}/assets/`);
    const overrideCSS = `<style>
      #canvas { display: none !important; }
      #preloader { display: none !important; }
      #transition-overlay { display: none !important; }
      #video-overlay { display: none !important; }
      #input-blocker { display: none !important; }
      #page-extra-sections { display: block !important; }
      #project-details { position: relative !important; }
      #project-details-meta { position: relative !important; transform: none !important; opacity: 1 !important; }
      #project-details-meta.is-active { display: flex !important; flex-wrap: wrap !important; padding: 40px !important; }
      #project-details-title { opacity: 1 !important; transform: none !important; font-size: 3rem !important; margin-bottom: 20px !important; width: 100% !important; }
      #project-details-desc { opacity: 1 !important; transform: none !important; }
      #project-details-left { opacity: 1 !important; transform: none !important; }
      #project-details-right { opacity: 1 !important; transform: none !important; }
      #project-details-launch-cta { opacity: 1 !important; transform: none !important; }
      #project-details-side-list-services { visibility: visible !important; opacity: 1 !important; transform: none !important; }
      #project-details-side-list-recognitions { visibility: visible !important; opacity: 1 !important; transform: none !important; }
      #project-details-header-info { display: none !important; }
      #project-details-preview { display: none !important; }
      #project-details-items-wrapper { position: relative !important; display: flex !important; flex-wrap: wrap !important; gap: 20px !important; padding: 20px 40px !important; }
      .project-details-item { position: relative !important; top: auto !important; width: 100% !important; max-width: 800px !important; height: auto !important; aspect-ratio: 16/9 !important; }
      #scroll-indicator { display: none !important; }
      #ui { position: relative !important; }
      body { background: #121414 !important; color: #fff !important; overflow: auto !important; }
    </style>`;
    html = html.replace('<head>', `<head><base href="/preview/${slug}/">${overrideCSS}`);

    const screenshotExists = existsSync(resolve(`./output/${slug}/screenshot.png`));
    if (screenshotExists) {
      html = html.replace('<div id="project-details-items-wrapper">',
        `<div style="padding: 20px 40px;"><img src="/preview/${slug}/screenshot.png" style="width:100%;max-width:1200px;border-radius:8px;margin-bottom:20px;" alt="Page screenshot"></div><div id="project-details-items-wrapper">`);
    }

    reply.type('text/html').send(html);
  });

  // Health check
  fastify.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Caching reverse proxy — catch-all for lusion.co content (MUST be last)
  await fastify.register(proxyPlugin);

  return fastify;
}

async function main() {
  const server = await buildServer();
  const port = parseInt(process.env.PORT ?? '3001', 10);

  try {
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Proxy integrated — lusion.co content served from same port`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();

export { buildServer };
