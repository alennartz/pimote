import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStaticHostRegistry } from './static-host/registry.js';
import type { DownloadManager } from './file-download/manager.js';

const { serveFileDownloadRoute } = vi.hoisted(() => ({
  serveFileDownloadRoute: vi.fn(),
}));

vi.mock('./file-download/index.js', () => ({
  serveFileDownloadRoute,
}));

import { createServer, type PimoteServer } from './server.js';
import type { FolderRegistry } from './folder-registry.js';
import type { FolderListingService } from './folder-listing.js';
import type { RepoIndex } from './repo-index.js';
import type { FolderInfo, PimoteEvent, ServerCapabilitiesEvent } from '../../shared/dist/index.js';
import { WebSocket } from 'ws';

function makeDownloads(): DownloadManager {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    detach: vi.fn(),
    offer: vi.fn(),
    cancel: vi.fn(),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

describe('createServer — file download route wiring', () => {
  let server: PimoteServer;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    serveFileDownloadRoute.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await server?.close();
  });

  it('delegates a /d request to the process-lifetime download manager before SPA fallback', async () => {
    const downloads = makeDownloads();
    serveFileDownloadRoute.mockImplementation(async (req, res) => {
      if (req.url !== '/d/opaque-1') return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('downloaded');
      return true;
    });

    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      downloads,
    );
    await server.start(0);
    const port = (server.httpServer.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/d/opaque-1`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('downloaded');
    expect(serveFileDownloadRoute).toHaveBeenCalledWith(expect.anything(), expect.anything(), downloads);
  });
});

describe('createServer — folders_changed broadcast wiring', () => {
  let server: PimoteServer;

  afterEach(async () => {
    await server?.close();
  });

  it('broadcasts the listing service-built delta on registry mutations and on repo-index refreshes', async () => {
    const folder: FolderInfo = {
      path: '/w/a',
      name: 'a',
      nature: 'code',
      shortcutCount: 0,
      favorite: true,
      archived: false,
      tags: [],
      missing: false,
      activeSessionCount: 0,
      externalProcessCount: 0,
    };
    const registryListeners: Array<(change: { changedPaths: string[]; removedPaths: string[] }) => void> = [];
    const folderRegistry = {
      onChange: (cb: (change: { changedPaths: string[]; removedPaths: string[] }) => void) => {
        registryListeners.push(cb);
        return () => {};
      },
      list: async () => [{ ...folder }],
    } as unknown as FolderRegistry;
    const refreshListeners: Array<(change: { changedPaths: string[]; removedPaths: string[] }) => void> = [];
    const repoIndex = {
      roots: ['/w'],
      list: async () => [],
      setOnRefreshed: (cb: (change: { changedPaths: string[]; removedPaths: string[] }) => void) => {
        refreshListeners.push(cb);
      },
    } as unknown as RepoIndex;
    const delta: PimoteEvent = { type: 'folders_changed', changed: [{ ...folder }], removedPaths: ['/w/gone'], epoch: 3 };
    const buildDelta = vi.fn(async () => delta);
    const folderListing = { buildDelta } as unknown as FolderListingService;

    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      { getAllSessions: () => [] } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
      undefined,
      repoIndex,
      folderRegistry,
      undefined,
      folderListing,
    );
    await server.start(0);

    const seen: PimoteEvent[] = [];
    server.clientRegistry.set('c1', { sendToClient: (event: PimoteEvent) => seen.push(event) } as any);

    // Curation and hub changes route through the registry subscription.
    expect(registryListeners).toHaveLength(1);
    registryListeners[0]!({ changedPaths: ['/w/a'], removedPaths: ['/w/gone'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toContainEqual(delta);
    expect(buildDelta).toHaveBeenLastCalledWith(['/w/a'], ['/w/gone']);

    // Changed repo refreshes ride the same channel.
    seen.length = 0;
    expect(refreshListeners).toHaveLength(1);
    refreshListeners[0]!({ changedPaths: ['/w/discovered'], removedPaths: ['/w/removed'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toContainEqual(delta);
    expect(buildDelta).toHaveBeenLastCalledWith(['/w/discovered'], ['/w/removed']);
  });
});

describe('createServer — session metadata invalidation', () => {
  let server: PimoteServer;

  afterEach(async () => {
    await server?.close();
  });

  it.each(['onStatusChange', 'onSessionClosed'] as const)('%s invalidates targeted metadata without a folder delta', async (callback) => {
    const invalidateSessionMetadata = vi.fn();
    const buildDelta = vi.fn();
    const folderListing = { invalidateSessionMetadata, buildDelta } as unknown as FolderListingService;
    const sessionManager = {
      getSession: () => undefined,
      getAllSessions: () => [],
    } as any;
    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      sessionManager,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
      undefined,
      undefined,
      undefined,
      undefined,
      folderListing,
    );
    await server.start(0);
    const seen: PimoteEvent[] = [];
    server.clientRegistry.set('c1', { sendToClient: (event: PimoteEvent) => seen.push(event) } as any);
    sessionManager[callback]('s', '/w/a');
    expect(invalidateSessionMetadata).toHaveBeenCalledWith(['/w/a']);
    expect(seen.map((event) => event.type)).toEqual(['session_state_changed']);
    expect(buildDelta).not.toHaveBeenCalled();
  });
});

describe('createServer — app name branding', () => {
  let server: PimoteServer;
  let tmp: string;
  let previousClientDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pimote-brand-'));
    mkdirSync(join(tmp, 'pwa'), { recursive: true });
    writeFileSync(
      join(tmp, 'index.html'),
      '<!doctype html><html><head>' + '<meta name="application-name" content="Pimote" />' + '<meta name="apple-mobile-web-app-title" content="Pimote" />' + '</head></html>',
    );
    writeFileSync(join(tmp, 'pwa', 'manifest.json'), JSON.stringify({ name: 'Pimote', short_name: 'Pimote', start_url: '/' }));
    previousClientDir = process.env.CLIENT_DIR;
    process.env.CLIENT_DIR = tmp;
  });

  afterEach(async () => {
    await server?.close();
    if (previousClientDir === undefined) delete process.env.CLIENT_DIR;
    else process.env.CLIENT_DIR = previousClientDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function startWith(config: Record<string, unknown>): Promise<string> {
    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0, ...config } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
    );
    await server.start(0);
    const port = (server.httpServer.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it('serves the manifest and HTML shell with the configured app name', async () => {
    const base = await startWith({ appName: 'Desk Pi' });

    const manifest = await (await fetch(`${base}/pwa/manifest.json`)).json();
    expect(manifest.name).toBe('Desk Pi');
    expect(manifest.short_name).toBe('Desk Pi');
    expect(manifest.start_url).toBe('/');

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<meta name="application-name" content="Desk Pi" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Desk Pi" />');

    const spaFallback = await (await fetch(`${base}/some/client/route`)).text();
    expect(spaFallback).toContain('<meta name="application-name" content="Desk Pi" />');
  });

  it('falls back to the default name when the config has none', async () => {
    const base = await startWith({});

    const manifest = await (await fetch(`${base}/pwa/manifest.json`)).json();
    expect(manifest.name).toBe('Pimote');
  });
});

describe('createServer — server_capabilities advertisement', () => {
  let server: PimoteServer;

  afterEach(async () => {
    await server?.close();
  });

  async function startServer(voiceOrchestrator: unknown): Promise<number> {
    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      voiceOrchestrator as any,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
    );
    await server.start(0);
    return (server.httpServer.address() as AddressInfo).port;
  }

  /** Resolves with the server's capabilities event for a fresh WS connection. */
  function awaitCapabilities(port: number): Promise<ServerCapabilitiesEvent> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timed out waiting for server_capabilities'));
      }, 2000);
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as PimoteEvent;
        if (event.type === 'server_capabilities') {
          clearTimeout(timer);
          ws.close();
          resolve(event);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('advertises voice disabled when no voice orchestrator is wired', async () => {
    const port = await startServer(undefined);
    await expect(awaitCapabilities(port)).resolves.toEqual({ type: 'server_capabilities', voice: false });
  });

  it('advertises voice enabled when a voice orchestrator is wired', async () => {
    const port = await startServer({ callHolder: new Map() });
    await expect(awaitCapabilities(port)).resolves.toEqual({ type: 'server_capabilities', voice: true });
  });
});

describe('createServer — malformed WebSocket frames', () => {
  let server: PimoteServer;
  let error: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    error?.mockRestore();
    await server?.close();
  });

  function awaitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for WebSocket open')), 2000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function awaitClose(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for WebSocket close')), 2000);
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.once('error', () => {
        // The malformed frame is written through the client socket. The ws
        // client can report the resulting peer close as an error as well.
      });
    });
  }

  it('handles an unmasked frame, cleans up the client, and accepts another connection', async () => {
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const releaseConnection = vi.fn();
    const folderListing = { releaseConnection } as unknown as FolderListingService;
    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      new InMemoryStaticHostRegistry(),
      makeDownloads(),
      undefined,
      undefined,
      undefined,
      undefined,
      folderListing,
    );
    await server.start(0);
    const port = (server.httpServer.address() as AddressInfo).port;
    const clientId = 'malformed-client';
    const malformed = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${clientId}`);
    await awaitOpen(malformed);
    expect(server.clientRegistry.has(clientId)).toBe(true);

    const close = awaitClose(malformed);
    const socket = (malformed as unknown as { _socket?: { write(data: Buffer): void } })._socket;
    expect(socket).toBeDefined();
    socket!.write(Buffer.from([0x81, 0x01, 0x78]));
    await expect(close).resolves.toBe(1002);

    expect(error.mock.calls.some(([, err]) => (err as { code?: string })?.code === 'WS_ERR_EXPECTED_MASK')).toBe(true);
    await vi.waitFor(() => expect(server.clientRegistry.has(clientId)).toBe(false), { timeout: 2000 });
    expect(releaseConnection).toHaveBeenCalledTimes(1);
    const [releasedOwner] = releaseConnection.mock.calls[0] ?? [];
    expect(releasedOwner).toEqual(expect.any(String));
    expect(releasedOwner).not.toBe(clientId);

    const healthy = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=healthy-client`);
    const capabilities = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for capabilities')), 2000);
      healthy.once('message', (raw) => {
        clearTimeout(timer);
        expect((JSON.parse(String(raw)) as PimoteEvent).type).toBe('server_capabilities');
        resolve();
      });
      healthy.once('error', reject);
    });
    await awaitOpen(healthy);
    await capabilities;
    healthy.close();
  });

  it('installs the error listener before the version-mismatch early return', async () => {
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clientDir = mkdtempSync(join(tmpdir(), 'pimote-ws-'));
    mkdirSync(join(clientDir, '_app'), { recursive: true });
    writeFileSync(join(clientDir, '_app', 'version.json'), JSON.stringify({ version: 'server-version' }));
    const previousClientDir = process.env.CLIENT_DIR;
    process.env.CLIENT_DIR = clientDir;
    try {
      server = await createServer(
        { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        undefined,
        new InMemoryStaticHostRegistry(),
        makeDownloads(),
      );
      await server.start(0);
    } finally {
      if (previousClientDir === undefined) delete process.env.CLIENT_DIR;
      else process.env.CLIENT_DIR = previousClientDir;
      rmSync(clientDir, { recursive: true, force: true });
    }

    const fakeWs = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      send: vi.fn((_payload: string, callback?: () => void) => callback?.()),
    });
    const on = vi.spyOn(fakeWs, 'on');
    server.wss.emit('connection', fakeWs as any, { url: '/ws?version=client-version' } as any);

    expect(on.mock.calls[0]?.[0]).toBe('error');
    expect(on.mock.calls[1]?.[0]).toBe('pong');
    expect(() => fakeWs.emit('error', Object.assign(new Error('malformed'), { code: 'WS_ERR_EXPECTED_MASK' }))).not.toThrow();
    expect(fakeWs.close).toHaveBeenCalled();
  });
});

describe('createServer — control document frame policy', () => {
  let server: PimoteServer;
  let clientRoot: string;
  let previousClientDir: string | undefined;
  let staticHostRegistry: InMemoryStaticHostRegistry;

  const indexHtml = '<!doctype html><html><body>pwa index</body></html>';
  const customHtml = '<!doctype html><html><body>custom document</body></html>';
  const bundleHtml = '<!doctype html><html><body>agent bundle</body></html>';

  beforeEach(async () => {
    clientRoot = mkdtempSync(join(tmpdir(), 'pimote-frame-policy-'));
    mkdirSync(join(clientRoot, 'bundle'), { recursive: true });
    writeFileSync(join(clientRoot, 'index.html'), indexHtml);
    writeFileSync(join(clientRoot, 'custom.html'), customHtml);
    writeFileSync(join(clientRoot, 'bundle', 'index.html'), bundleHtml);

    previousClientDir = process.env.CLIENT_DIR;
    process.env.CLIENT_DIR = clientRoot;

    staticHostRegistry = new InMemoryStaticHostRegistry();
    staticHostRegistry.register({
      slug: 'demo',
      folderPath: join(clientRoot, 'bundle'),
      sessionId: 'session',
      cardMetadata: { title: 'Demo' },
    });

    server = await createServer(
      { roots: [], managerRoot: '/tmp/manager-root', idleTimeout: 60_000, bufferSize: 10, port: 0 },
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      staticHostRegistry,
      makeDownloads(),
    );
    await server.start(0);
  });

  afterEach(async () => {
    await server?.close();
    if (previousClientDir === undefined) delete process.env.CLIENT_DIR;
    else process.env.CLIENT_DIR = previousClientDir;
    rmSync(clientRoot, { recursive: true, force: true });
  });

  function baseUrl(): string {
    const port = (server.httpServer.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it('sets frame-ancestors on control documents and preserves their content', async () => {
    const responses = [
      ['/', indexHtml],
      ['/index.html', indexHtml],
      ['/custom.html', customHtml],
      ['/some/client/route', indexHtml],
    ] as const;

    for (const [path, expectedBody] of responses) {
      const response = await fetch(`${baseUrl()}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      await expect(response.text()).resolves.toBe(expectedBody);
    }
  });

  it('sets frame-ancestors on the SPA fallback 404', async () => {
    rmSync(join(clientRoot, 'index.html'));

    const response = await fetch(`${baseUrl()}/missing/client/route`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    await expect(response.text()).resolves.toBe(JSON.stringify({ error: 'not found' }));
  });

  it('keeps static-host bundle serving and its WebSocket-blocking CSP unchanged', async () => {
    const response = await fetch(`${baseUrl()}/s/demo/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe('connect-src http: https:');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.text()).resolves.toBe(bundleHtml);
  });
});
