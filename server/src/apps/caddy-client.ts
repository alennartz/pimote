import type { AppRouteEntry, AppsConfig } from './types.js';
import { targetToCaddyDial } from './validation.js';

export interface AppRouteReconciler {
  reconcile(routes: readonly AppRouteEntry[]): Promise<void>;
}

export interface CaddyAdminClientOptions {
  caddyAdminUrl: string;
  caddyListen: string;
  caddyServerName: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CaddyReverseProxyHandler {
  handler: 'reverse_proxy';
  upstreams: Array<{ dial: string }>;
  transport?: {
    protocol: 'http';
    tls: Record<string, never>;
  };
  headers?: {
    request: {
      set: {
        Host: string[];
      };
    };
  };
}

interface CaddyStaticResponseHandler {
  handler: 'static_response';
  status_code: number;
  headers: Record<string, string[]>;
  body: string;
}

interface CaddyRoute {
  match?: Array<{ host: string[] }>;
  handle: Array<CaddyReverseProxyHandler | CaddyStaticResponseHandler>;
  terminal?: boolean;
}

export interface CaddyHttpServerConfig {
  listen: string[];
  automatic_https: { disable: true };
  routes: CaddyRoute[];
}

export function buildCaddyServerConfig(caddyListen: string, routes: readonly AppRouteEntry[]): CaddyHttpServerConfig {
  const sorted = [...routes].sort((a, b) => a.slug.localeCompare(b.slug));
  const appRoutes: CaddyRoute[] = sorted.map((entry) => {
    const { dial, isHttps } = targetToCaddyDial(entry.target);
    const handler: CaddyReverseProxyHandler = {
      handler: 'reverse_proxy',
      upstreams: [{ dial }],
      ...(isHttps
        ? {
            transport: { protocol: 'http', tls: {} },
            headers: {
              request: {
                set: {
                  Host: ['{http.reverse_proxy.upstream.hostport}'],
                },
              },
            },
          }
        : {}),
    };

    return {
      match: [{ host: [entry.hostname] }],
      handle: [handler],
      terminal: true,
    };
  });

  appRoutes.push({
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        body: 'Unknown Pimote app',
      },
    ],
  });

  return {
    listen: [caddyListen],
    automatic_https: { disable: true },
    routes: appRoutes,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reconciles Pimote's dedicated HTTP server block in an external Caddy sidecar via its localhost admin API. */
export class CaddyAdminClient implements AppRouteReconciler {
  private readonly adminBase: string;
  private readonly adminOrigin: string;
  private readonly caddyListen: string;
  private readonly caddyServerName: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CaddyAdminClientOptions) {
    this.adminBase = options.caddyAdminUrl.replace(/\/+$/, '');
    this.adminOrigin = new URL(this.adminBase).origin;
    this.caddyListen = options.caddyListen;
    this.caddyServerName = options.caddyServerName;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(config: AppsConfig, overrides: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): CaddyAdminClient {
    return new CaddyAdminClient({
      caddyAdminUrl: config.caddyAdminUrl,
      caddyListen: config.caddyListen,
      caddyServerName: config.caddyServerName,
      ...overrides,
    });
  }

  async reconcile(routes: readonly AppRouteEntry[]): Promise<void> {
    const serverConfig = buildCaddyServerConfig(this.caddyListen, routes);

    if (await this.isObjectAt('/config/apps/http/servers')) {
      await this.postJson(`/config/apps/http/servers/${encodeURIComponent(this.caddyServerName)}`, serverConfig);
      return;
    }

    if (await this.isObjectAt('/config/apps/http')) {
      await this.postJson('/config/apps/http/servers', { [this.caddyServerName]: serverConfig });
      return;
    }

    if (await this.isObjectAt('/config/apps')) {
      await this.postJson('/config/apps/http', {
        servers: { [this.caddyServerName]: serverConfig },
      });
      return;
    }

    await this.postJson('/config/apps', {
      http: {
        servers: { [this.caddyServerName]: serverConfig },
      },
    });
  }

  private async isObjectAt(path: string): Promise<boolean> {
    const response = await this.request('GET', path);
    if (response.status === 404) return false;
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(`Caddy admin GET ${path} failed (${response.status}): ${detail}`);
    }
    const text = (await response.text()).trim();
    if (!text) return false;
    try {
      return isPlainObject(JSON.parse(text));
    } catch {
      return false;
    }
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await this.request('POST', path, body);
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(`Caddy admin POST ${path} failed (${response.status}): ${detail}`);
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const url = `${this.adminBase}${path}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Origin: this.adminOrigin,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach Caddy admin API at ${this.adminBase}: ${message}`, { cause: error });
    }
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || response.statusText || 'unknown error';
  } catch {
    return response.statusText || 'unknown error';
  }
}
