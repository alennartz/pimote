import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/dist/index.js';
import { handleImageHttpRoute } from './image-http.js';

function request(method: string, url: string, body: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from(body.length ? [body] : []), { method, url, headers }) as http.IncomingMessage;
  const result: { status?: number; headers?: Record<string, string | number>; body?: Buffer } = {};
  const res = {
    writeHead(status: number, responseHeaders: Record<string, string | number>) {
      result.status = status;
      result.headers = responseHeaders;
      return this;
    },
    end(value?: string | Buffer) {
      result.body = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
    },
  } as unknown as http.ServerResponse;
  return { req, res, result };
}

describe('image HTTP routes', () => {
  it('stores uploaded bytes and serves them by their content-addressed path', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 254]);
    const upload = request('POST', '/api/images', bytes, { 'content-type': 'image/png', 'content-length': String(bytes.length) });
    expect(await handleImageHttpRoute(upload.req, upload.res)).toBe(true);
    expect(upload.result.status).toBe(201);
    const { url } = JSON.parse(upload.result.body!.toString()) as { url: string };
    expect(url).toMatch(/^\/i\/[a-f0-9]{64}$/);

    const read = request('GET', url);
    expect(await handleImageHttpRoute(read.req, read.res)).toBe(true);
    expect(read.result.status).toBe(200);
    expect(read.result.headers).toMatchObject({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
    expect(read.result.body).toEqual(bytes);
  });

  it('rejects non-image uploads, oversized uploads, and unknown references', async () => {
    const wrongType = request('POST', '/api/images', Buffer.from('not an image'), { 'content-type': 'text/plain' });
    await handleImageHttpRoute(wrongType.req, wrongType.res);
    expect(wrongType.result.status).toBe(415);

    const tooLarge = request('POST', '/api/images', Buffer.alloc(0), {
      'content-type': 'image/png',
      'content-length': String(Math.floor((MAX_IMAGE_BASE64_LENGTH * 3) / 4) + 1),
    });
    await handleImageHttpRoute(tooLarge.req, tooLarge.res);
    expect(tooLarge.result.status).toBe(413);

    const missing = request('GET', `/i/${'e'.repeat(64)}`);
    await handleImageHttpRoute(missing.req, missing.res);
    expect(missing.result.status).toBe(404);
  });

  it('serves HEAD metadata without an image body', async () => {
    const bytes = Buffer.from('head-test');
    const upload = request('POST', '/api/images', bytes, { 'content-type': 'image/jpeg' });
    await handleImageHttpRoute(upload.req, upload.res);
    const { url } = JSON.parse(upload.result.body!.toString()) as { url: string };
    const head = request('HEAD', url);
    await handleImageHttpRoute(head.req, head.res);
    expect(head.result.status).toBe(200);
    expect(head.result.headers?.['Content-Length']).toBe(bytes.length);
    expect(head.result.body).toEqual(Buffer.alloc(0));
  });
});
