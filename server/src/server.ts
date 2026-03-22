import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PimoteConfig } from './config.js';

export interface PimoteServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  start(port: number): Promise<void>;
  close(): Promise<void>;
}

export function createServer(config: PimoteConfig): PimoteServer {
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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

    ws.on('message', (data) => {
      console.log('[pimote] WebSocket message received:', data.toString().slice(0, 200));
    });

    ws.on('close', () => {
      console.log('[pimote] WebSocket client disconnected');
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
