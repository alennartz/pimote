import type http from 'node:http';
import type { StaticHostRegistry } from './registry.js';

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
export async function serveStaticHostRoute(_req: http.IncomingMessage, _res: http.ServerResponse, _registry: StaticHostRegistry): Promise<boolean> {
  throw new Error('not implemented');
}
