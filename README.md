# Lusion Crawler

Web crawler for [lusion.co](https://lusion.co) projects. Collects HTML, CSS, JS, images, videos, 3D models and metadata from project pages.

## Architecture

```
apps/
  server/    Fastify backend + Playwright crawler + SQLite (Drizzle ORM)
  web/       Next.js 14 (App Router) + shadcn/ui + Tailwind CSS
packages/
  shared/    Shared TypeScript types
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Install & Run

```bash
npm install
npx playwright install chromium

# Start both server (port 3001) and web (port 3000):
npm run dev:server   # Terminal 1
npm run dev:web      # Terminal 2
```

### Docker

```bash
docker-compose up
```

Open http://localhost:3000

## API

| Method | Path              | Description          |
|--------|-------------------|----------------------|
| POST   | /api/crawl        | Start crawl          |
| GET    | /api/crawl/:id    | Crawl status         |
| DELETE | /api/crawl/:id    | Cancel crawl         |
| GET    | /api/projects     | List projects        |
| GET    | /api/projects/:slug | Project details    |
| WS     | /ws/crawl/:id     | Realtime progress    |

## Tests

```bash
npm test
```

## Stack

- **Frontend:** Next.js 14, TypeScript, shadcn/ui, Tailwind CSS
- **Backend:** Fastify, TypeScript, Playwright, Drizzle ORM, SQLite
- **Realtime:** WebSocket via @fastify/websocket
- **Tests:** Vitest
- **Monorepo:** npm workspaces
