import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PimoteEvent, PimoteResponse, PimoteServerMessage } from '../../../shared/dist/index.js';
import { createServer, type PimoteServer } from '../server.js';
import { InMemoryStaticHostRegistry } from '../static-host/index.js';
import { AppService, FileAppStore, type AppRouteReconciler } from './index.js';

interface WsClient {
  ws: WebSocket;
  events: PimoteEvent[];
  sendCommand(command: Record<string, unknown>): Promise<PimoteResponse>;
  waitForEvent(predicate: (event: PimoteEvent) => boolean, timeoutMs?: number): Promise<PimoteEvent>;
  close(): void;
}

function connectClient(port: number, clientId: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${encodeURIComponent(clientId)}`);
    const events: PimoteEvent[] = [];
    const pendingResponses = new Map<string, (response: PimoteResponse) => void>();
    const waiters: Array<{ predicate: (event: PimoteEvent) => boolean; resolve: (event: PimoteEvent) => void }> = [];
    let nextId = 1;

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as PimoteServerMessage;
      if ('id' in msg && 'success' in msg) {
        const resolver = pendingResponses.get(msg.id);
        if (resolver) {
          pendingResponses.delete(msg.id);
          resolver(msg);
        }
        return;
      }
      const event = msg as PimoteEvent;
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.predicate(event)) {
          const matched = waiters.splice(i, 1)[0]!;
          matched.resolve(event);
        }
      }
    });

    ws.once('open', () => {
      resolve({
        ws,
        events,
        sendCommand(command) {
          const id = `req-${nextId++}`;
          return new Promise<PimoteResponse>((res) => {
            pendingResponses.set(id, res);
            ws.send(JSON.stringify({ ...command, id }));
          });
        },
        waitForEvent(predicate, timeoutMs = 2000) {
          const existing = events.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise<PimoteEvent>((res, rej) => {
            const timer = setTimeout(() => rej(new Error('Timed out waiting for WebSocket event')), timeoutMs);
            waiters.push({
              predicate,
              resolve: (event) => {
                clearTimeout(timer);
                res(event);
              },
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.once('error', reject);
  });
}

describe('Apps WebSocket protocol integration', () => {
  let dir: string;
  let server: PimoteServer;
  let port: number;
  const clients: WsClient[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pimote-apps-ws-'));
    const reconciler: AppRouteReconciler = { reconcile: async () => undefined };
    const appService = new AppService({
      config: {
        publicUrlTemplate: 'https://{slug}.apps.example.com',
        caddyAdminUrl: 'http://127.0.0.1:2019',
        caddyListen: '127.0.0.1:8080',
        caddyServerName: 'pimote_apps',
      },
      pimotePort: 3000,
      store: new FileAppStore(join(dir, 'apps.json')),
      reconciler,
    });
    await appService.initialize();

    server = await createServer(
      { roots: [dir], managerRoot: join(dir, 'manager'), idleTimeout: 60_000, bufferSize: 100, port: 0 },
      { getAllSessions: () => [], getSession: () => undefined } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      { appService },
    );

    await server.start(0);
    const addr = server.httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP port');
    port = addr.port;
  });

  afterEach(async () => {
    while (clients.length > 0) clients.pop()!.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('advertises apps capability, handles CRUD commands, and broadcasts apps_changed to other clients', async () => {
    const alice = await connectClient(port, 'alice');
    const bob = await connectClient(port, 'bob');
    clients.push(alice, bob);

    const caps = await alice.waitForEvent((e) => e.type === 'server_capabilities');
    expect(caps).toMatchObject({ type: 'server_capabilities', apps: true });

    const registerResp = await alice.sendCommand({
      type: 'register_app',
      slug: 'planner',
      title: 'Planner',
      target: 'http://127.0.0.1:4173',
      description: 'Task board',
    });
    expect(registerResp.success).toBe(true);
    expect(registerResp.data).toMatchObject({
      app: { slug: 'planner', title: 'Planner', url: 'https://planner.apps.example.com' },
      sync: { status: 'synced' },
    });

    const broadcast = await bob.waitForEvent((e) => e.type === 'apps_changed' && e.apps.length === 1);
    expect(broadcast).toMatchObject({
      type: 'apps_changed',
      apps: [{ slug: 'planner', title: 'Planner' }],
      sync: { status: 'synced' },
    });

    const listResp = await bob.sendCommand({ type: 'list_apps' });
    expect(listResp.success).toBe(true);
    expect((listResp.data as { apps: unknown[] }).apps).toHaveLength(1);

    const updateResp = await bob.sendCommand({
      type: 'update_app',
      slug: 'planner',
      title: 'Planner Pro',
    });
    expect(updateResp.success).toBe(true);
    expect(updateResp.data).toMatchObject({ app: { title: 'Planner Pro' } });

    const removeResp = await alice.sendCommand({ type: 'remove_app', slug: 'planner' });
    expect(removeResp.success).toBe(true);
    expect(removeResp.data).toMatchObject({ removed: true });

    const emptyBroadcast = await bob.waitForEvent((e) => e.type === 'apps_changed' && e.apps.length === 0);
    expect(emptyBroadcast).toMatchObject({ type: 'apps_changed', apps: [] });
  });
});
