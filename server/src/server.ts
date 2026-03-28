import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PimoteConfig } from './config.js';
import type { PimoteSessionManager } from './session-manager.js';
import type { FolderIndex } from './folder-index.js';
import type { PushNotificationService } from './push-notification.js';
import { WsHandler } from './ws-handler.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR || join(__dirname, '..', '..', 'client', 'build');

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
async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
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
      res.writeHead(200, { 'Content-Type': mime });
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
  start(port: number): Promise<void>;
  close(): Promise<void>;
}

export function createServer(
  config: PimoteConfig,
  sessionManager: PimoteSessionManager,
  folderIndex: FolderIndex,
  pushNotificationService: PushNotificationService,
): PimoteServer {
  const httpServer = http.createServer(async (req, res) => {
    // 1. Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 2. Static file lookup
    if (req.method === 'GET') {
      const served = await serveStatic(req, res);
      if (served) return;
    }

    // 3. SPA fallback — serve index.html for unmatched GET routes
    if (req.method === 'GET') {
      await serveFallback(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[pimote] WebSocket client connected');

    const handler = new WsHandler(sessionManager, folderIndex, ws, pushNotificationService);

    ws.on('message', (data) => {
      handler.handleMessage(data.toString()).catch((err) => {
        console.error('[pimote] Unhandled error in message handler:', err);
      });
    });

    ws.on('close', () => {
      console.log('[pimote] WebSocket client disconnected');
      handler.cleanup();
    });
  });

  return {
    httpServer,
    wss,
    start(port: number): Promise<void> {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        wss.close(() => {
          httpServer.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    },
  };
}
