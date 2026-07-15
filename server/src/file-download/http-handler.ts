import type http from 'node:http';
import type { DownloadManager } from './manager.js';

/**
 * Handle the one-shot `/d/<opaque-id>` attachment route.
 *
 * Returns `true` only when the request belongs to this route; callers may
 * continue with SPA fallback for `false`.
 */
export async function serveFileDownloadRoute(_req: http.IncomingMessage, _res: http.ServerResponse, _downloads: DownloadManager): Promise<boolean> {
  throw new Error('not implemented');
}
