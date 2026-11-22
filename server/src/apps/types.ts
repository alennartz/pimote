import type { AppInfo, AppsSyncState } from '../../../shared/dist/index.js';

export type { AppInfo, AppsSyncState };

export interface AppsConfig {
  /** Public URL pattern containing `{slug}` in a DNS label, e.g. `https://{slug}.apps.example.com`. */
  publicUrlTemplate: string;
  /** Loopback URL for Caddy's private admin API, e.g. `http://127.0.0.1:2019`. */
  caddyAdminUrl: string;
  /** Listen address for the Pimote-managed Caddy HTTP server, e.g. `127.0.0.1:8080`. */
  caddyListen: string;
  /** Server key under Caddy's `/config/apps/http/servers/<name>`. */
  caddyServerName: string;
}

export interface PersistedAppRecord {
  slug: string;
  title: string;
  description?: string;
  icon?: string;
  target: string;
  createdAt: string;
  updatedAt: string;
  createdBySessionId?: string;
  folderPath?: string;
}

export interface AppStoreFile {
  version: 1;
  apps: PersistedAppRecord[];
}

export interface RegisterAppInput {
  slug: string;
  title: string;
  target: string;
  description?: string;
  icon?: string;
  overwrite?: boolean;
  createdBySessionId?: string;
  folderPath?: string;
}

export interface UpdateAppInput {
  slug: string;
  title?: string;
  description?: string;
  icon?: string;
  target?: string;
}

export interface AppRouteEntry {
  slug: string;
  hostname: string;
  target: string;
}

export interface AppsSnapshot {
  apps: AppInfo[];
  sync: AppsSyncState;
}
