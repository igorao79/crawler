import type { WebSocket } from '@fastify/websocket';
import type { CrawlProgress } from '@lusion-crawler/shared';

const clientsByJobId = new Map<string, Set<WebSocket>>();

export function addClient(jobId: string, ws: WebSocket): void {
  if (!clientsByJobId.has(jobId)) {
    clientsByJobId.set(jobId, new Set());
  }
  clientsByJobId.get(jobId)!.add(ws);

  ws.on('close', () => {
    const clients = clientsByJobId.get(jobId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        clientsByJobId.delete(jobId);
      }
    }
  });
}

export function broadcastProgress(progress: CrawlProgress): void {
  const clients = clientsByJobId.get(progress.jobId);
  if (!clients) return;

  const message = JSON.stringify(progress);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

export function removeAllClients(jobId: string): void {
  clientsByJobId.delete(jobId);
}
