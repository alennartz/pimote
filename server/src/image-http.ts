import type http from 'node:http';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/dist/index.js';
import { getRegisteredImage, registerImage } from './image-registry.js';

const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_LENGTH * 3) / 4);
const IMAGE_REF_PATTERN = /^\/i\/([a-f0-9]{64})$/;

function replyJson(res: http.ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serialized);
}

async function readBoundedBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) return null;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > MAX_IMAGE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/** Handle content-addressed image upload and retrieval routes. */
export async function handleImageHttpRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return false;
  }

  if (req.method === 'POST' && pathname === '/api/images') {
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) {
      replyJson(res, 415, { error: 'image_content_type_required' });
      return true;
    }
    const body = await readBoundedBody(req);
    if (!body) {
      replyJson(res, 413, { error: 'image_too_large' });
      return true;
    }
    const url = registerImage(contentType, body);
    if (!url) {
      replyJson(res, 400, { error: 'invalid_image' });
      return true;
    }
    replyJson(res, 201, { url });
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!pathname.startsWith('/i/')) return false;
  const match = IMAGE_REF_PATTERN.exec(pathname);
  if (!match) {
    replyJson(res, 404, { error: 'image_not_found' });
    return true;
  }
  const image = getRegisteredImage(match[1]);
  if (!image) {
    if (req.method === 'HEAD') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end();
    } else {
      replyJson(res, 404, { error: 'image_not_found' });
    }
    return true;
  }
  res.writeHead(200, {
    'Content-Type': image.mimeType,
    'Content-Length': image.buffer.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(image.buffer);
  return true;
}
