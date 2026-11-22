import { describe, expect, it, vi } from 'vitest';
import { createAppIconProxy, type AppIconSource } from './icon-proxy.js';
import type { AppInfo } from './types.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

function makeApp(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    slug: 'notes',
    title: 'Notes',
    target: 'http://127.0.0.1:4173',
    url: 'https://notes.apps.example.com',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  body?: Buffer | string;
  contentLength?: string | null;
}

function fakeFetch(responses: Record<string, FakeResponseInit>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const init = responses[url] ?? { ok: false, status: 404 };
    const body = init.body ?? Buffer.alloc(0);
    const headers = new Headers();
    if (init.contentType !== undefined) headers.set('content-type', init.contentType);
    if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
    return new Response(body as BodyInit, { status: init.status ?? (init.ok === false ? 404 : 200), headers });
  }) as typeof fetch;
}

function makeRequest(path: string, headers: Record<string, string> = {}): { req: import('node:http').IncomingMessage; res: import('node:http').ServerResponse } {
  const req = { method: 'GET', url: path, headers } as unknown as import('node:http').IncomingMessage;
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as import('node:http').ServerResponse;
  return { req, res };
}

function makeProxy(source: AppIconSource, responses: Record<string, FakeResponseInit>, calls: string[] = []) {
  return createAppIconProxy({ source, fetchImpl: fakeFetch(responses, calls), now: (() => 1_000_000) as () => number });
}

describe('createAppIconProxy', () => {
  it('ignores non-icon routes and methods', async () => {
    const source: AppIconSource = { get: () => makeApp({ icon: 'https://up.example/icon.png' }) };
    const handle = makeProxy(source, {});

    expect(await handle({ method: 'GET', url: '/health', headers: {} } as never, {} as never)).toBe(false);
    expect(await handle({ method: 'POST', url: '/app-icons/notes', headers: {} } as never, {} as never)).toBe(false);
  });

  it('404s unknown slugs and apps without icons', async () => {
    const source: AppIconSource = { get: (slug) => (slug === 'noicon' ? makeApp({ slug }) : undefined) };
    const handle = makeProxy(source, {});

    const missing = makeRequest('/app-icons/ghost');
    expect(await handle(missing.req, missing.res)).toBe(true);
    expect(missing.res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({ 'Content-Type': expect.stringContaining('json') }));

    const noicon = makeRequest('/app-icons/noicon');
    expect(await handle(noicon.req, noicon.res)).toBe(true);
    expect(noicon.res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  it('fetches the icon once and serves cached bytes with the upstream content type', async () => {
    const calls: string[] = [];
    const source: AppIconSource = { get: () => makeApp({ icon: 'https://up.example/icon.png' }) };
    const handle = makeProxy(source, { 'https://up.example/icon.png': { contentType: 'image/png', body: PNG_BYTES } }, calls);

    const first = makeRequest('/app-icons/notes');
    expect(await handle(first.req, first.res)).toBe(true);
    expect(first.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' }));
    expect(vi.mocked(first.res.end).mock.calls[0]?.[0]).toEqual(PNG_BYTES);

    const second = makeRequest('/app-icons/notes');
    expect(await handle(second.req, second.res)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('answers 304 on matching If-None-Match', async () => {
    const source: AppIconSource = { get: () => makeApp({ icon: 'https://up.example/icon.png' }) };
    const handle = makeProxy(source, { 'https://up.example/icon.png': { contentType: 'image/png', body: PNG_BYTES } });

    const initial = makeRequest('/app-icons/notes');
    await handle(initial.req, initial.res);
    const etag = (vi.mocked(initial.res.writeHead).mock.calls[0]?.[1] as Record<string, string>).ETag;
    expect(etag).toBeTruthy();

    const revalidate = makeRequest('/app-icons/notes', { 'if-none-match': etag });
    expect(await handle(revalidate.req, revalidate.res)).toBe(true);
    expect(revalidate.res.writeHead).toHaveBeenCalledWith(304, expect.objectContaining({ ETag: etag }));
  });

  it('404s and negatively caches non-image responses, upstream errors, and oversized bodies', async () => {
    const calls: string[] = [];
    const source: AppIconSource = { get: () => makeApp({ icon: 'https://up.example/icon' }) };
    const handle = makeProxy(
      source,
      {
        'https://up.example/icon': { contentType: 'text/html', body: '<html></html>' },
      },
      calls,
    );

    const first = makeRequest('/app-icons/notes');
    expect(await handle(first.req, first.res)).toBe(true);
    expect(first.res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(calls).toHaveLength(1);

    const second = makeRequest('/app-icons/notes');
    expect(await handle(second.req, second.res)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('refetches when the icon URL changes', async () => {
    const calls: string[] = [];
    let app = makeApp({ icon: 'https://up.example/one.png' });
    const source: AppIconSource = { get: () => app };
    const handle = makeProxy(
      source,
      {
        'https://up.example/one.png': { contentType: 'image/png', body: PNG_BYTES },
        'https://up.example/two.png': { contentType: 'image/png', body: Buffer.from('other') },
      },
      calls,
    );

    const first = makeRequest('/app-icons/notes');
    await handle(first.req, first.res);

    app = makeApp({ icon: 'https://up.example/two.png' });
    const second = makeRequest('/app-icons/notes');
    await handle(second.req, second.res);
    expect(second.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'image/png' }));
    expect(calls).toEqual(['https://up.example/one.png', 'https://up.example/two.png']);
  });
});
