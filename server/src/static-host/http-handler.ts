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

// Match `/s/<slug>/<remainder>` — the trailing slash after the slug is
// REQUIRED. Without it, browsers resolve relative asset URLs against `/s/`
// instead of `/s/<slug>/` and every asset 404s. `/s/<slug>` (no slash) is
// handled separately below with a 301 redirect to `/s/<slug>/`.
const PREFIX_RE = /^\/s\/([a-z0-9-]+)\/(.*)$/;
const PREFIX_NO_SLASH_RE = /^\/s\/([a-z0-9-]+)$/;

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

  // `/s/<slug>` (no trailing slash) — redirect to the canonical form so the
  // browser resolves relative asset URLs against `/s/<slug>/`.
  const noSlashMatch = PREFIX_NO_SLASH_RE.exec(pathname);
  if (noSlashMatch) {
    const [, slug] = noSlashMatch;
    if (!registry.lookup(slug)) {
      send404(res);
      return true;
    }
    res.writeHead(301, { Location: `/s/${slug}/`, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end();
    return true;
  }

  const m = PREFIX_RE.exec(pathname);
  if (!m) return false;
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

  // Stream errors AFTER `writeHead(200)` cannot be turned into a 5xx — headers
  // are already on the wire. Destroy the response and resolve cleanly so the
  // rejection does not bubble out of the async request handler as an
  // unhandled rejection.
  await new Promise<void>((resolvePromise) => {
    const stream = createReadStream(resolved);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    stream.on('error', (err) => {
      console.warn('[static-host] stream error while serving', resolved, err);
      try {
        res.destroy();
      } catch {
        // ignore
      }
      settle();
    });
    stream.on('end', settle);
    res.on('close', () => {
      stream.destroy();
      settle();
    });
    stream.pipe(res);
  });
  return true;
}
