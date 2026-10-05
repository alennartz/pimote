import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { RepoIndex } from './repo-index.js';
import type { FolderInfo, PimoteEvent } from '../../shared/dist/index.js';

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

  it('broadcasts the merged folder list on registry mutations and on repo-index refreshes', async () => {
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
    const registryListeners: Array<() => void> = [];
    const folderRegistry = {
      onChange: (cb: () => void) => {
        registryListeners.push(cb);
        return () => {};
      },
      list: async () => [{ ...folder }],
    } as unknown as FolderRegistry;
    const refreshListeners: Array<() => void> = [];
    const repoIndex = {
      roots: ['/w'],
      list: async () => [],
      setOnRefreshed: (cb: () => void) => {
        refreshListeners.push(cb);
      },
    } as unknown as RepoIndex;

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
    );
    await server.start(0);

    const seen: PimoteEvent[] = [];
    server.clientRegistry.set('c1', { sendToClient: (event: PimoteEvent) => seen.push(event) } as any);

    // Curation and hub changes route through the registry subscription.
    expect(registryListeners).toHaveLength(1);
    registryListeners[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toContainEqual({ type: 'folders_changed', folders: [{ ...folder }] });

    // Changed repo refreshes ride the same channel.
    seen.length = 0;
    expect(refreshListeners).toHaveLength(1);
    refreshListeners[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toContainEqual({ type: 'folders_changed', folders: [{ ...folder }] });
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
