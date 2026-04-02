import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PimoteConfig } from './config.js';
import type { PimoteSessionManager } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import type { PushNotificationService } from './push-notification.js';
import { WsHandler, type ClientRegistry } from './ws-handler.js';
import crypto from 'node:crypto';
import type { VersionMismatchEvent } from '@pimote/shared';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR || join(__dirname, '..', '..', 'client', 'build');

/** Read the SvelteKit build version from _app/version.json. Returns null if unavailable. */
async function loadClientVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(CLIENT_DIR, '_app', 'version.json'), 'utf-8');
    const data = JSON.parse(raw);
    return data.version ?? null;
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Try to serve a static file from CLIENT_DIR. Returns true if served. */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const urlPath = req.url === '/' ? '/index.html' : req.url!.split('?')[0];
  const filePath = join(CLIENT_DIR, urlPath);

  // Prevent directory traversal — ensure path is within CLIENT_DIR
  if (!filePath.startsWith(CLIENT_DIR + '/') && filePath !== CLIENT_DIR) {
    return false;
  }

  try {
    const stats = await stat(filePath);
    if (stats.isFile()) {
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await readFile(filePath);
      const headers: Record<string, string> = { 'Content-Type': mime };

      // HTML, SW, and manifest must not be cached by CDN/proxies.
      // Immutable hashed assets (_app/immutable/) are safe to cache.
      if (urlPath === '/sw.js' || urlPath === '/pwa/manifest.json' || ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['CDN-Cache-Control'] = 'no-store';
        headers['Cloudflare-CDN-Cache-Control'] = 'no-store';
      } else if (urlPath.startsWith('/_app/immutable/')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }

      res.writeHead(200, headers);
      res.end(content);
      return true;
    }
  } catch {
    // File not found — fall through
  }
  return false;
}

/** Serve index.html as SPA fallback. */
async function serveFallback(res: http.ServerResponse): Promise<void> {
  try {
    const indexPath = join(CLIENT_DIR, 'index.html');
    const content = await readFile(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

export interface PimoteServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  clientRegistry: ClientRegistry;
  start(port: number): Promise<void>;
  close(): Promise<void>;
}

export async function createServer(
  config: PimoteConfig,
  sessionManager: PimoteSessionManager,
  folderIndex: FolderIndex,
  pushNotificationService: PushNotificationService,
): Promise<PimoteServer> {
  const clientVersion = await loadClientVersion();
  if (clientVersion) {
    console.log(`[pimote] Client build version: ${clientVersion}`);
  } else {
    console.warn(`[pimote] Could not read client build version from ${CLIENT_DIR}/_app/version.json`);
  }
  const httpServer = http.createServer(async (req, res) => {
    // 1. Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 2. VAPID public key for push notification subscription
    if (req.method === 'GET' && req.url === '/api/vapid-key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: config.vapidPublicKey ?? '' }));
      return;
    }

    // 3. Static file lookup
    if (req.method === 'GET') {
      const served = await serveStatic(req, res);
      if (served) return;
    }

    // 4. SPA fallback — serve index.html for unmatched GET routes
    if (req.method === 'GET') {
      await serveFallback(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // Wire up session manager callbacks for sidebar broadcasts
  sessionManager.onStatusChange = (sessionId, folderPath) => {
    WsHandler.broadcastSidebarUpdate(sessionId, folderPath, sessionManager, clientRegistry);
  };
  sessionManager.onSessionClosed = (sessionId, folderPath) => {
    WsHandler.broadcastSidebarUpdate(sessionId, folderPath, sessionManager, clientRegistry);
  };

  const wss = new WebSocketServer({ noServer: true });
  const clientRegistry: ClientRegistry = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
    console.log(`[pimote] WebSocket client connected (clientId=${clientId})`);

    // Version check — if the client's build version doesn't match the server's,
    // send a version_mismatch event and close. The client will reload.
    const incomingVersion = url.searchParams.get('version');
    if (clientVersion && incomingVersion && incomingVersion !== clientVersion) {
      console.log(`[pimote] Version mismatch: client=${incomingVersion}, server=${clientVersion} — requesting reload`);
      const event: VersionMismatchEvent = { type: 'version_mismatch', serverVersion: clientVersion };
      ws.send(JSON.stringify(event), () => ws.close());
      return;
    }

    // Register new handler first, then clean up and close any stale connection.
    // cleanup() disconnects the old handler's WebSocket routing (sets managed.ws = null).
    // Pending UI responses survive on the ManagedSession for replay when the new
    // handler's reconnect commands reclaim sessions via claimSession().
    // The close handler skips cleanup when the registry already points to a
    // different handler, so this is the only place it runs.
    const existing = clientRegistry.get(clientId);
    const handler = new WsHandler(sessionManager, folderIndex, ws, pushNotificationService, clientId, clientRegistry);
    clientRegistry.set(clientId, handler);
    if (existing) {
      existing.cleanup();
      existing.closeWebSocket();
    }

    ws.on('message', (data) => {
      handler.handleMessage(data.toString()).catch((err) => {
        console.error('[pimote] Unhandled error in message handler:', err);
      });
    });

    ws.on('close', () => {
      console.log(`[pimote] WebSocket client disconnected (clientId=${clientId})`);
      // Only clean up if this handler is still the current entry.
      // If a new handler replaced us (stale-connection reconnect), the new
      // handler owns the sessions — don't orphan them.
      if (clientRegistry.get(clientId) === handler) {
        clientRegistry.delete(clientId);
        handler.cleanup();
      }
    });
  });

  return {
    httpServer,
    wss,
    clientRegistry,
    start(port: number): Promise<void> {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // Force-close all active WebSocket connections
        wss.clients.forEach((client) => {
          client.close();
        });

        // Close the WebSocket server with a timeout to prevent hanging
        const timeout = setTimeout(() => {
          console.warn('[pimote] WebSocket server close timeout — forcing shutdown');
          httpServer.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }, 5000);

        wss.close((err) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            httpServer.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          }
        });
      });
    },
  };
}
