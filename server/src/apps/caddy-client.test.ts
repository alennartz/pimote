import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CaddyAdminClient } from './caddy-client.js';

interface StubCaddy {
  url: string;
  config: Record<string, unknown> | null;
  close(): Promise<void>;
}

function getAtPath(root: unknown, segments: string[]): unknown {
  let cursor = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor ?? null;
}

function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`Invalid traversal path at ${segments.slice(0, i + 1).join('/')}`);
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

async function startStubCaddy(initialConfig: Record<string, unknown> | null = null): Promise<StubCaddy> {
  const state: { config: Record<string, unknown> | null } = { config: initialConfig };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const expectedOrigin = `http://${req.headers.host}`;
    if (req.headers.origin !== expectedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `client is not allowed to access from origin ${JSON.stringify(req.headers.origin ?? '')}` }));
      return;
    }
    const prefix = '/config/';
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404).end('not found');
      return;
    }

    const segments = pathname
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));

    if (req.method === 'GET') {
      const value = getAtPath(state.config, segments);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
      return;
    }

    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (state.config === null) {
            state.config = {};
          }
          setAtPath(state.config, segments, body);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('null');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end(error instanceof Error ? error.message : String(error));
        }
      });
      return;
    }

    res.writeHead(405).end('method not allowed');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind stub Caddy server');

  return {
    url: `http://127.0.0.1:${address.port}`,
    get config() {
      return state.config;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('CaddyAdminClient', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('bootstraps an empty Caddy instance with app routes and a catch-all 404 route', async () => {
    const caddy = await startStubCaddy(null);
    cleanups.push(() => caddy.close());

    const client = new CaddyAdminClient({
      caddyAdminUrl: caddy.url,
      caddyListen: '127.0.0.1:8080',
      caddyServerName: 'pimote_apps',
    });

    await client.reconcile([
      { slug: 'notes', hostname: 'notes.apps.example.com', target: 'http://127.0.0.1:4173' },
      { slug: 'remote', hostname: 'remote.apps.example.com', target: 'https://dash.internal' },
    ]);

    const serverConfig = getAtPath(caddy.config, ['apps', 'http', 'servers', 'pimote_apps']) as {
      listen: string[];
      automatic_https: { disable: boolean };
      routes: Array<Record<string, unknown>>;
    };

    expect(serverConfig.listen).toEqual(['127.0.0.1:8080']);
    expect(serverConfig.automatic_https).toEqual({ disable: true });
    expect(serverConfig.routes).toHaveLength(3);
    expect(serverConfig.routes[0]).toMatchObject({
      match: [{ host: ['notes.apps.example.com'] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:4173' }] }],
      terminal: true,
    });
    expect(serverConfig.routes[1]).toMatchObject({
      match: [{ host: ['remote.apps.example.com'] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: 'dash.internal:443' }],
          transport: { protocol: 'http', tls: {} },
          headers: { request: { set: { Host: ['{http.reverse_proxy.upstream.hostport}'] } } },
        },
      ],
      terminal: true,
    });
    expect(serverConfig.routes[2]).toMatchObject({
      handle: [{ handler: 'static_response', status_code: 404 }],
    });
  });

  it('preserves unrelated Caddy HTTP servers when updating pimote_apps', async () => {
    const caddy = await startStubCaddy({
      apps: {
        http: {
          servers: {
            other_server: { listen: [':9999'], routes: [] },
          },
        },
      },
    });
    cleanups.push(() => caddy.close());

    const client = new CaddyAdminClient({
      caddyAdminUrl: caddy.url,
      caddyListen: '127.0.0.1:8080',
      caddyServerName: 'pimote_apps',
    });

    await client.reconcile([{ slug: 'demo', hostname: 'demo.apps.example.com', target: 'http://127.0.0.1:5173' }]);

    expect(getAtPath(caddy.config, ['apps', 'http', 'servers', 'other_server'])).toEqual({ listen: [':9999'], routes: [] });
    expect(getAtPath(caddy.config, ['apps', 'http', 'servers', 'pimote_apps'])).toBeTruthy();
  });

  it('surfaces a clear error when Caddy admin is unreachable', async () => {
    const client = new CaddyAdminClient({
      caddyAdminUrl: 'http://127.0.0.1:1',
      caddyListen: '127.0.0.1:8080',
      caddyServerName: 'pimote_apps',
      timeoutMs: 500,
    });

    await expect(client.reconcile([])).rejects.toThrow(/Unable to reach Caddy admin API/);
  });
});
