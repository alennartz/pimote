import type http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { StaticHostRegistry } from './registry.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

const PREFIX_RE = /^\/s\/([a-z0-9-]+)(?:\/(.*))?$/;

function send404(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end('Not Found');
}

/**
 * HTTP handler for the `/s/<slug>/*` route prefix.
 *
 * Behaviour:
 *   - Path does not match `/s/<slug>/...` => returns `false` (caller falls
 *     through to the SPA fallback).
 *   - Slug not in the registry => 404, returns `true` (does NOT fall through).
 *   - Resolved path escapes the registered folder (e.g. `..` traversal) => 404.
 *   - Resolved path is a directory => append `index.html`.
 *   - File missing => 404. File present => 200, content-type by extension,
 *     streamed body, no-cache response headers.
 *
 * Returns `true` if the request was handled (any 2xx/4xx response written),
 * `false` only on prefix mismatch.
 */
export async function serveStaticHostRoute(req: http.IncomingMessage, res: http.ServerResponse, registry: StaticHostRegistry): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '', 'http://x').pathname;
  } catch {
    return false;
  }

  const m = PREFIX_RE.exec(pathname);
  if (!m) return false;
  // The regex requires the trailing slash after the slug to provide a
  // remainder group; `/s/foo` (no slash, no remainder) fails the match.
  const [, slug, rawRemainder = ''] = m;

  const reg = registry.lookup(slug);
  if (!reg) {
    send404(res);
    return true;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRemainder);
  } catch {
    send404(res);
    return true;
  }

  // Defence-in-depth: reject any decoded path containing backslash, NUL,
  // or `..` segments before resolving.
  if (decoded.includes('\\') || decoded.includes('\u0000')) {
    send404(res);
    return true;
  }
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..')) {
    send404(res);
    return true;
  }

  const folderPath = reg.folderPath;
  let resolved = path.resolve(folderPath, decoded);
  if (resolved !== folderPath && !resolved.startsWith(folderPath + path.sep)) {
    send404(res);
    return true;
  }

  let st;
  try {
    st = await stat(resolved);
  } catch {
    send404(res);
    return true;
  }

  if (st.isDirectory()) {
    resolved = path.join(resolved, 'index.html');
    try {
      st = await stat(resolved);
    } catch {
      send404(res);
      return true;
    }
  }

  if (!st.isFile()) {
    send404(res);
    return true;
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(resolved);
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
    stream.pipe(res);
  });
  return true;
}
