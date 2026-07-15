import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';
import { serveFileDownloadRoute } from './http-handler.js';
import type { DownloadClaim, DownloadManager } from './manager.js';

type FetchResult = {
  status: number;
  body: string;
  contentDisposition: string | null;
  cacheControl: string | null;
  contentType: string | null;
  handled: boolean;
};

function makeManager(claims: Map<string, DownloadClaim | undefined>): DownloadManager & { claim: ReturnType<typeof vi.fn> } {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    offer: vi.fn(),
    cancel: vi.fn(),
    claim: vi.fn(async (id: string) => claims.get(id)),
    snapshot: vi.fn(() => []),
  };
}

describe('serveFileDownloadRoute', () => {
  let root: string;
  let port: number;
  let server: http.Server;
  let manager: DownloadManager & { claim: ReturnType<typeof vi.fn> };
  let lastHandled: boolean | null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'file-download-http-'));
    await writeFile(join(root, 'report.pdf'), 'download body', 'utf8');
    await mkdir(join(root, 'directory'));
    lastHandled = null;
    manager = makeManager(new Map());
    server = http.createServer(async (req, res) => {
      try {
        lastHandled = await serveFileDownloadRoute(req, res, manager);
        if (!lastHandled) {
          res.writeHead(599, { 'content-type': 'text/plain' });
          res.end('fell-through');
        }
      } catch (error) {
        lastHandled = true;
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function request(path: string, init?: RequestInit): Promise<FetchResult> {
    lastHandled = null;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return {
      status: response.status,
      body: await response.text(),
      contentDisposition: response.headers.get('content-disposition'),
      cacheControl: response.headers.get('cache-control'),
      contentType: response.headers.get('content-type'),
      handled: lastHandled === true,
    };
  }

  function get(path: string): Promise<FetchResult> {
    return request(path);
  }

  function claim(id: string, overrides: Partial<DownloadClaim> = {}): void {
    (manager.claim as ReturnType<typeof vi.fn>).mockImplementation(async (requested: string) =>
      requested === id
        ? {
            sessionId: 'session-1',
            sourcePath: join(root, 'report.pdf'),
            workspaceRoot: root,
            filename: 'report.pdf',
            ...overrides,
          }
        : undefined,
    );
  }

  it('falls through for non-download paths', async () => {
    const result = await get('/other/path');
    expect(result.handled).toBe(false);
    expect(result.status).toBe(599);
    expect(result.body).toBe('fell-through');
    expect(manager.claim).not.toHaveBeenCalled();
  });

  it('falls through for a non-GET request without claiming its opaque id', async () => {
    claim('opaque-1');
    const result = await request('/d/opaque-1', { method: 'POST' });
    expect(result.handled).toBe(false);
    expect(result.status).toBe(599);
    expect(manager.claim).not.toHaveBeenCalled();
  });

  it('recognizes only one opaque id path segment', async () => {
    const result = await get('/d');
    expect(result.handled).toBe(false);
    expect(result.status).toBe(599);

    const nested = await get('/d/opaque-1/extra');
    expect(nested.handled).toBe(false);
    expect(nested.status).toBe(599);
  });

  it('returns 404 for an unknown or already-consumed id', async () => {
    const result = await get('/d/unknown');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(404);
    expect(result.body).not.toContain('download body');
  });

  it('claims before checking or opening the source path', async () => {
    claim('missing', { sourcePath: join(root, 'does-not-exist.bin'), filename: 'missing.bin' });
    const result = await get('/d/missing');
    expect(manager.claim).toHaveBeenCalledWith('missing');
    expect(result.status).toBe(404);
  });

  it('returns a generic 500 without opening source bytes when durable claim removal fails', async () => {
    (manager.claim as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('durable removal failed'));

    const result = await get('/d/opaque-1');

    expect(manager.claim).toHaveBeenCalledWith('opaque-1');
    expect(result.status).toBe(500);
    expect(result.body).not.toContain('download body');
    expect(result.body).not.toContain('durable removal failed');
  });

  it('streams a valid source as a native attachment without caching', async () => {
    claim('opaque-1');
    const result = await get('/d/opaque-1');
    expect(result.status).toBe(200);
    expect(result.body).toBe('download body');
    expect(result.contentDisposition).toMatch(/^attachment;/i);
    expect(result.contentDisposition).toMatch(/report\.pdf/);
    expect(result.cacheControl?.toLowerCase()).toMatch(/no-(cache|store)/);
    expect(result.contentType).toMatch(/octet-stream|application\/pdf/);
    await expect(access(join(root, 'report.pdf'))).resolves.toBeUndefined();
  });

  it('streams the source as it exists when the browser claims it', async () => {
    claim('live');
    await writeFile(join(root, 'report.pdf'), 'changed before click', 'utf8');

    const result = await get('/d/live');

    expect(result.status).toBe(200);
    expect(result.body).toBe('changed before click');
  });

  it('uses the registration filename with safe content-disposition encoding', async () => {
    claim('quoted', { filename: 'report "final".txt' });
    const result = await get('/d/quoted');
    expect(result.status).toBe(200);
    expect(result.contentDisposition).toMatch(/^attachment;/i);
    expect(result.contentDisposition).not.toContain('\r');
    expect(result.contentDisposition).not.toContain('\n');
  });

  it('returns a normal error when the claimed source is no longer regular', async () => {
    claim('directory', { sourcePath: join(root, 'directory'), filename: 'directory' });
    const result = await get('/d/directory');
    expect(result.status).toBe(404);
  });

  it('consumes a claim even when current real-path validation rejects a symlink escape', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'file-download-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
      claim('escape', { sourcePath: join(root, 'escape.txt'), filename: 'escape.txt' });
      const result = await get('/d/escape');
      expect(result.status).toBe(404);
      expect(result.body).not.toContain('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not permit an encoded request path to select a source file', async () => {
    claim('opaque-1');
    const result = await get('/d/opaque-1/%2E%2E%2Freport.pdf');
    expect(result.handled).toBe(false);
    expect(manager.claim).not.toHaveBeenCalled();
  });
});
