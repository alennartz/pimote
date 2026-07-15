import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { InMemoryStaticHostRegistry } from './static-host/registry.js';
import type { DownloadManager } from './file-download/manager.js';

const { serveFileDownloadRoute } = vi.hoisted(() => ({
  serveFileDownloadRoute: vi.fn(),
}));

vi.mock('./file-download/index.js', () => ({
  serveFileDownloadRoute,
}));

import { createServer, type PimoteServer } from './server.js';

function makeDownloads(): DownloadManager {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
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
      { roots: [], idleTimeout: 60_000, bufferSize: 10, port: 0 },
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
