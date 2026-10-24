import { describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { createDefaultSpeechmuxClientFactory } from './speechmux-client.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForDisconnect(register: (listener: () => void) => () => void, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for speechmux disconnect'));
    }, timeoutMs);
    const unsubscribe = register(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createDefaultSpeechmuxClientFactory', () => {
  it('times out a hanging upgrade without an unhandled socket error and closes the remote socket', async () => {
    const server = createServer();
    let upgradeSocket: Socket | undefined;
    let resolveRemoteClose: (() => void) | undefined;
    const remoteClose = new Promise<void>((resolve) => {
      resolveRemoteClose = resolve;
    });
    server.on('upgrade', (_request: IncomingMessage, socket: Socket) => {
      upgradeSocket = socket;
      socket.on('error', () => undefined);
      socket.once('end', () => {
        socket.destroy();
        resolveRemoteClose?.();
      });
    });
    const port = await listen(server);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);

    try {
      const factory = createDefaultSpeechmuxClientFactory();
      await expect(factory({ wsUrl: `ws://127.0.0.1:${port}`, connectTimeoutMs: 20 })).rejects.toThrow('SpeechmuxClient: connect timeout after 20ms');
      await expect(remoteClose).resolves.toBeUndefined();
      await nextTurn();
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      upgradeSocket?.destroy();
      await closeServer(server);
    }
  });

  it('rejects the original pre-open error without waiting for the connect timeout', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(400);
      response.end('not a websocket');
    });
    const port = await listen(server);

    try {
      const factory = createDefaultSpeechmuxClientFactory();
      await expect(factory({ wsUrl: `ws://127.0.0.1:${port}`, connectTimeoutMs: 1000 })).rejects.toThrow('Unexpected server response: 400');
      await nextTurn();
    } finally {
      await closeServer(server);
    }
  });

  it('handles a post-open protocol error, notifies once, and rejects sends after the remote closes', async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    let peer: WebSocket | undefined;
    let peerSocket: Socket | undefined;
    let resolvePeerClose: (() => void) | undefined;
    const peerClose = new Promise<void>((resolve) => {
      resolvePeerClose = resolve;
    });
    server.on('upgrade', (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (accepted) => {
        peer = accepted;
        peerSocket = (accepted as WebSocket & { _socket: Socket })._socket;
        accepted.on('error', () => undefined);
        accepted.once('close', () => resolvePeerClose?.());
        webSockets.emit('connection', accepted, request);
      });
    });
    const port = await listen(server);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.on('uncaughtException', onUncaught);

    try {
      const factory = createDefaultSpeechmuxClientFactory();
      const client = await factory({ wsUrl: `ws://127.0.0.1:${port}` });
      expect(peer).toBeDefined();
      expect(peerSocket).toBeDefined();
      const disconnect = vi.fn();
      const disconnected = waitForDisconnect((listener) => client.onDisconnect(listener));
      client.onDisconnect(disconnect);

      peerSocket!.write(Buffer.from([0xc1, 0x01, 0x78]));
      await expect(disconnected).resolves.toBeUndefined();
      await expect(peerClose).resolves.toBeUndefined();
      await nextTurn();

      expect(uncaught).toEqual([]);
      expect(logError).toHaveBeenCalledWith('[voice] speechmux WebSocket error:', expect.any(Error));
      expect(disconnect).toHaveBeenCalledOnce();
      expect(() => client.send({ type: 'token', text: 'after-close' })).toThrow('SpeechmuxClient: socket is not open');
      client.close();
      client.close();
    } finally {
      process.off('uncaughtException', onUncaught);
      logError.mockRestore();
      peerSocket?.destroy();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(server);
    }
  });

  it('closes an open client idempotently and notifies its disconnect listener once', async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    let peerSocket: Socket | undefined;
    let resolvePeerClose: (() => void) | undefined;
    const peerClose = new Promise<void>((resolve) => {
      resolvePeerClose = resolve;
    });
    server.on('upgrade', (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (accepted) => {
        peerSocket = (accepted as WebSocket & { _socket: Socket })._socket;
        accepted.on('error', () => undefined);
        accepted.once('close', () => resolvePeerClose?.());
        webSockets.emit('connection', accepted, request);
      });
    });
    const port = await listen(server);

    try {
      const factory = createDefaultSpeechmuxClientFactory();
      const client = await factory({ wsUrl: `ws://127.0.0.1:${port}` });
      const disconnect = vi.fn();
      const disconnected = waitForDisconnect((listener) => client.onDisconnect(listener));
      client.onDisconnect(disconnect);

      client.close();
      client.close();
      await expect(disconnected).resolves.toBeUndefined();
      await expect(peerClose).resolves.toBeUndefined();

      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      peerSocket?.destroy();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(server);
    }
  });
});
