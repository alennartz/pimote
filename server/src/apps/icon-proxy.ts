import type http from 'node:http';
import { createHash } from 'node:crypto';
import type { AppInfo } from './types.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const OK_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const ROUTE_PREFIX = '/app-icons/';
const APP_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface OkCacheEntry {
  state: 'ok';
  iconUrl: string;
  contentType: string;
  bytes: Buffer;
  etag: string;
  fetchedAt: number;
}

interface NegativeCacheEntry {
  state: 'error';
  iconUrl: string;
  fetchedAt: number;
}

type CacheEntry = OkCacheEntry | NegativeCacheEntry;

export interface AppIconSource {
  get(slug: string): AppInfo | undefined;
}

export interface AppIconProxyOptions {
  source: AppIconSource;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
  timeoutMs?: number;
}

function etagFor(bytes: Buffer): string {
  return `"${createHash('sha1').update(bytes).digest('hex')}"`;
}

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

/**
 * Serves each App's icon from Pimote's own origin at /app-icons/{slug} so the
 * browser never loads cross-origin images. The upstream icon is fetched once,
 * validated (image content type, size cap, timeout), and cached in memory;
 * failures are negatively cached briefly. Clients revalidate with an ETag, so
 * unchanged icons cost a 304 while edited icons refresh on the next load.
 */
export function createAppIconProxy(options: AppIconProxyOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();

  async function load(app: AppInfo): Promise<CacheEntry> {
    const cached = cache.get(app.slug);
    if (cached && cached.iconUrl === app.icon && now() - cached.fetchedAt < (cached.state === 'ok' ? OK_TTL_MS : NEGATIVE_TTL_MS)) {
      return cached;
    }

    const entry = await fetchIcon(app.icon!);
    cache.set(app.slug, entry);
    return entry;
  }

  async function fetchIcon(iconUrl: string): Promise<CacheEntry> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(iconUrl, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        return { state: 'error', iconUrl, fetchedAt: now() };
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) {
        return { state: 'error', iconUrl, fetchedAt: now() };
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return { state: 'error', iconUrl, fetchedAt: now() };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes || buffer.length === 0) {
        return { state: 'error', iconUrl, fetchedAt: now() };
      }
      return { state: 'ok', iconUrl, contentType, bytes: buffer, etag: etagFor(buffer), fetchedAt: now() };
    } catch {
      return { state: 'error', iconUrl, fetchedAt: now() };
    } finally {
      clearTimeout(timer);
    }
  }

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(ROUTE_PREFIX)) return false;

    const slug = pathname.slice(ROUTE_PREFIX.length);
    const app = APP_SLUG_RE.test(slug) ? options.source.get(slug) : undefined;
    if (!app || !app.icon) {
      replyJson(res, 404, { error: 'icon_not_found' });
      return true;
    }

    const entry = await load(app);
    if (entry.state !== 'ok') {
      replyJson(res, 404, { error: 'icon_not_found' });
      return true;
    }

    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.bytes.length,
      'Cache-Control': 'no-cache',
      ETag: entry.etag,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(entry.bytes);
    return true;
  };
}
