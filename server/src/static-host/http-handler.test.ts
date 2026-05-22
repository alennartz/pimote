import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';
import { InMemoryStaticHostRegistry } from './registry.js';
import { serveStaticHostRoute } from './http-handler.js';

interface FetchResult {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: string;
  handled: boolean;
}

describe('serveStaticHostRoute', () => {
  let root: string;
  let registry: InMemoryStaticHostRegistry;
  let server: http.Server;
  let port: number;
  let lastHandled: boolean | null = null;

  async function get(path: string): Promise<FetchResult> {
    lastHandled = null;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      body,
      handled: lastHandled !== false,
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'static-host-http-'));
    registry = new InMemoryStaticHostRegistry();

    server = http.createServer(async (req, res) => {
      const handled = await serveStaticHostRoute(req, res, registry);
      lastHandled = handled;
      if (!handled) {
        res.writeHead(599, { 'Content-Type': 'text/plain' });
        res.end('fell-through');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  async function bundle(name: string, files: Record<string, string>): Promise<string> {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = join(folder, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
    return folder;
  }

  it('serves index.html when the path points at the bundle root', async () => {
    const folder = await bundle('demo', { 'index.html': '<h1>hi</h1>' });
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    const r = await get('/s/demo/');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toBe('<h1>hi</h1>');
  });

  it('serves a nested asset and infers content-type from the extension', async () => {
    const folder = await bundle('demo', {
      'index.html': 'x',
      'assets/style.css': 'body{}',
      'assets/app.js': 'console.log(1)',
    });
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    const css = await get('/s/demo/assets/style.css');
    expect(css.status).toBe(200);
    expect(css.contentType).toMatch(/text\/css/);
    expect(css.body).toBe('body{}');

    const js = await get('/s/demo/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.contentType).toMatch(/javascript/);
  });

  it('serves index.html when the path points at a subdirectory', async () => {
    const folder = await bundle('demo', { 'index.html': 'root', 'sub/index.html': 'sub' });
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    const r = await get('/s/demo/sub/');
    expect(r.status).toBe(200);
    expect(r.body).toBe('sub');
  });

  it('returns 404 (not a fall-through) when the slug is unknown', async () => {
    const r = await get('/s/ghost/');
    expect(r.status).toBe(404);
    expect(r.body).not.toBe('fell-through');
  });

  it('falls through to the caller when the request does not match /s/<slug>/', async () => {
    const r = await get('/other/path');
    expect(r.handled).toBe(false);
    expect(r.status).toBe(599);
    expect(r.body).toBe('fell-through');
  });

  it('falls through for `/s` (no trailing slash, no slug)', async () => {
    const r = await get('/s');
    expect(r.handled).toBe(false);
  });

  it('returns 404 when the file inside the bundle is missing', async () => {
    const folder = await bundle('demo', { 'index.html': 'root' });
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    const r = await get('/s/demo/missing.txt');
    expect(r.status).toBe(404);
  });

  it('rejects path traversal attempts that escape the bundle folder', async () => {
    const folder = await bundle('demo', { 'index.html': 'safe' });
    // Place a sibling secret outside the bundle folder.
    await writeFile(join(root, 'secret.txt'), 'SECRET', 'utf-8');
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    // Use percent-encoded separators so the URL parser doesn't normalise the
    // `..` segment away client-side. The handler is expected to decode the
    // path and then reject anything that resolves outside `folderPath`.
    const rPosix = await get('/s/demo/..%2Fsecret.txt');
    expect(rPosix.handled).toBe(true);
    expect(rPosix.status).toBe(404);
    expect(rPosix.body).not.toContain('SECRET');

    // Backslash-style traversal (Windows path separator). Must also be rejected
    // — platforms vary, and the handler should defend against both.
    const rWin = await get('/s/demo/..%5Csecret.txt');
    expect(rWin.handled).toBe(true);
    expect(rWin.status).toBe(404);
    expect(rWin.body).not.toContain('SECRET');
  });

  it('sets a no-cache response for served files', async () => {
    const folder = await bundle('demo', { 'index.html': 'hi' });
    registry.register({ slug: 'demo', folderPath: folder, sessionId: 's', cardMetadata: { title: 'D' } });

    const r = await get('/s/demo/');
    expect(r.cacheControl).toBeTruthy();
    expect(r.cacheControl!.toLowerCase()).toMatch(/no-(cache|store)/);
  });
});
