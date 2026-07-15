import type http from 'node:http';
import { createReadStream } from 'node:fs';
import { validateDownloadSource } from './source.js';
import type { DownloadManager } from './manager.js';

const DOWNLOAD_PATH = /^\/d\/([^/]+)$/;

function downloadIdForRequest(req: http.IncomingMessage): string | undefined {
  if (req.method !== 'GET') return undefined;

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '', 'http://pimote.local').pathname;
  } catch {
    return undefined;
  }

  return DOWNLOAD_PATH.exec(pathname)?.[1];
}

function sendStatus(res: http.ServerResponse, status: 404 | 500): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

function asciiFilenameFallback(filename: string): string {
  const safeFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return safeFilename || 'download';
}

function encodeRfc5987Filename(filename: string): string {
  try {
    return encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return encodeURIComponent(asciiFilenameFallback(filename));
  }
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${asciiFilenameFallback(filename)}"; filename*=UTF-8''${encodeRfc5987Filename(filename)}`;
}

function closeResponse(res: http.ServerResponse): void {
  if (!res.destroyed) res.destroy();
}

async function streamDownload(res: http.ServerResponse, sourcePath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const stream = createReadStream(sourcePath);
    // Promise settlement is idempotent, so every terminal stream/response
    // event can share this completion callback without a mutable guard.
    const settle = () => resolve();

    stream.once('error', () => {
      closeResponse(res);
      settle();
    });
    res.once('error', () => {
      stream.destroy();
      settle();
    });
    res.once('close', () => {
      stream.destroy();
      settle();
    });
    res.once('finish', settle);
    stream.pipe(res);
  });
}

/**
 * Handle the one-shot `/d/<opaque-id>` attachment route.
 *
 * Returns `true` only when the request belongs to this route; callers may
 * continue with SPA fallback for `false`.
 */
export async function serveFileDownloadRoute(req: http.IncomingMessage, res: http.ServerResponse, downloads: DownloadManager): Promise<boolean> {
  const id = downloadIdForRequest(req);
  if (!id) return false;

  let claim;
  try {
    claim = await downloads.claim(id);
  } catch {
    sendStatus(res, 500);
    return true;
  }

  if (!claim) {
    sendStatus(res, 404);
    return true;
  }

  let source;
  try {
    source = await validateDownloadSource({
      sourcePath: claim.sourcePath,
      workspaceRoot: claim.workspaceRoot,
    });
  } catch {
    sendStatus(res, 404);
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(claim.filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  await streamDownload(res, source.resolvedPath);
  return true;
}
