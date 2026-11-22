import type { AppRouteReconciler } from './caddy-client.js';
import type { AppStore } from './store.js';
import type { AppInfo, AppRouteEntry, AppsConfig, AppsSnapshot, AppsSyncState, PersistedAppRecord, RegisterAppInput, UpdateAppInput } from './types.js';
import {
  buildBlockedLocalPorts,
  renderAppHostname,
  renderPublicUrl,
  validateAppDescription,
  validateAppIcon,
  validateAppSlug,
  validateAppTarget,
  validateAppTitle,
} from './validation.js';

export interface AppServiceOptions {
  config: AppsConfig;
  pimotePort: number;
  store: AppStore;
  reconciler: AppRouteReconciler;
  now?: () => Date;
}

export type AppsChangeListener = (snapshot: AppsSnapshot) => void;

function sortAppInfos(apps: AppInfo[]): AppInfo[] {
  return apps.sort((a, b) => {
    const titleOrder = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (titleOrder !== 0) return titleOrder;
    return a.slug.localeCompare(b.slug);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Process-global service owning durable App registrations, atomic persistence, and Caddy reconciliation. */
export class AppService {
  private readonly config: AppsConfig;
  private readonly store: AppStore;
  private readonly reconciler: AppRouteReconciler;
  private readonly blockedLocalPorts: ReadonlyMap<number, string>;
  private readonly now: () => Date;

  private readonly records = new Map<string, PersistedAppRecord>();
  private readonly listeners = new Set<AppsChangeListener>();
  private sync: AppsSyncState = { status: 'synced' };
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: AppServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.reconciler = options.reconciler;
    this.blockedLocalPorts = buildBlockedLocalPorts(options.config, options.pimotePort);
    this.now = options.now ?? (() => new Date());
  }

  /** Load persisted Apps and reconcile Caddy. Never throws on Caddy outage so Pimote boots cleanly. */
  async initialize(): Promise<AppsSnapshot> {
    return this.enqueue(async () => {
      const file = await this.store.read();
      this.records.clear();
      for (const record of file.apps) {
        try {
          const slug = validateAppSlug(record.slug);
          const title = validateAppTitle(record.title);
          const description = validateAppDescription(record.description);
          const icon = validateAppIcon(record.icon, { blockedLocalPorts: this.blockedLocalPorts });
          const target = validateAppTarget(record.target, { blockedLocalPorts: this.blockedLocalPorts });
          this.records.set(slug, {
            slug,
            title,
            ...(description !== undefined ? { description } : {}),
            ...(icon !== undefined ? { icon } : {}),
            target,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(record.createdBySessionId !== undefined ? { createdBySessionId: record.createdBySessionId } : {}),
            ...(record.folderPath !== undefined ? { folderPath: record.folderPath } : {}),
          });
        } catch (error) {
          console.warn(`[apps] Skipping invalid persisted app ${JSON.stringify(record.slug)}: ${errorMessage(error)}`);
        }
      }

      await this.reconcileCurrentRoutes();
      return this.snapshot();
    });
  }

  list(): AppInfo[] {
    const list: AppInfo[] = [];
    for (const record of this.records.values()) {
      list.push(this.toAppInfo(record));
    }
    return sortAppInfos(list);
  }

  get(slug: string): AppInfo | undefined {
    const record = this.records.get(slug);
    return record ? this.toAppInfo(record) : undefined;
  }

  syncState(): AppsSyncState {
    return { ...this.sync };
  }

  snapshot(): AppsSnapshot {
    return {
      apps: this.list(),
      sync: this.syncState(),
    };
  }

  onChange(listener: AppsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  register(input: RegisterAppInput): Promise<{ app: AppInfo; sync: AppsSyncState }> {
    return this.enqueue(async () => {
      const slug = validateAppSlug(input.slug);
      const title = validateAppTitle(input.title);
      const description = validateAppDescription(input.description);
      const icon = validateAppIcon(input.icon, { blockedLocalPorts: this.blockedLocalPorts });
      const target = validateAppTarget(input.target, { blockedLocalPorts: this.blockedLocalPorts });

      const existing = this.records.get(slug);
      if (existing && !input.overwrite) {
        throw new Error(`App slug "${slug}" is already registered. Pass overwrite=true to replace it or choose a different slug.`);
      }

      const timestamp = this.now().toISOString();
      const record: PersistedAppRecord = {
        slug,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(icon !== undefined ? { icon } : {}),
        target,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(input.createdBySessionId !== undefined
          ? { createdBySessionId: input.createdBySessionId }
          : existing?.createdBySessionId !== undefined
            ? { createdBySessionId: existing.createdBySessionId }
            : {}),
        ...(input.folderPath !== undefined ? { folderPath: input.folderPath } : existing?.folderPath !== undefined ? { folderPath: existing.folderPath } : {}),
      };

      const nextRecords = new Map(this.records);
      nextRecords.set(slug, record);
      await this.persistMap(nextRecords);
      this.records.set(slug, record);

      await this.reconcileCurrentRoutes();
      this.emitChange();

      return { app: this.toAppInfo(record), sync: this.syncState() };
    });
  }

  update(input: UpdateAppInput): Promise<{ app: AppInfo; sync: AppsSyncState }> {
    return this.enqueue(async () => {
      const slug = validateAppSlug(input.slug);
      const existing = this.records.get(slug);
      if (!existing) {
        throw new Error(`App not found: "${slug}"`);
      }

      const title = input.title !== undefined ? validateAppTitle(input.title) : existing.title;
      const description = input.description !== undefined ? validateAppDescription(input.description) : existing.description;
      const icon = input.icon !== undefined ? validateAppIcon(input.icon, { blockedLocalPorts: this.blockedLocalPorts }) : existing.icon;
      const target = input.target !== undefined ? validateAppTarget(input.target, { blockedLocalPorts: this.blockedLocalPorts }) : existing.target;

      const updated: PersistedAppRecord = {
        ...existing,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(icon !== undefined ? { icon } : {}),
        target,
        updatedAt: this.now().toISOString(),
      };
      if (description === undefined) {
        delete updated.description;
      }
      if (icon === undefined) {
        delete updated.icon;
      }

      const nextRecords = new Map(this.records);
      nextRecords.set(slug, updated);
      await this.persistMap(nextRecords);
      this.records.set(slug, updated);

      await this.reconcileCurrentRoutes();
      this.emitChange();

      return { app: this.toAppInfo(updated), sync: this.syncState() };
    });
  }

  remove(rawSlug: string): Promise<{ removed: boolean; sync: AppsSyncState }> {
    return this.enqueue(async () => {
      const slug = validateAppSlug(rawSlug);
      if (!this.records.has(slug)) {
        return { removed: false, sync: this.syncState() };
      }

      const nextRecords = new Map(this.records);
      nextRecords.delete(slug);
      await this.persistMap(nextRecords);
      this.records.delete(slug);

      await this.reconcileCurrentRoutes();
      this.emitChange();

      return { removed: true, sync: this.syncState() };
    });
  }

  resync(): Promise<{ sync: AppsSyncState }> {
    return this.enqueue(async () => {
      await this.reconcileCurrentRoutes();
      this.emitChange();
      return { sync: this.syncState() };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    const current = previous.catch(() => undefined).then(operation);
    this.mutationQueue = current.catch(() => undefined);
    return current;
  }

  private async persistMap(map: ReadonlyMap<string, PersistedAppRecord>): Promise<void> {
    const apps = [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    await this.store.write({ version: 1, apps });
  }

  private async reconcileCurrentRoutes(): Promise<void> {
    const routes: AppRouteEntry[] = [...this.records.values()].map((record) => ({
      slug: record.slug,
      hostname: renderAppHostname(this.config.publicUrlTemplate, record.slug),
      target: record.target,
    }));

    try {
      await this.reconciler.reconcile(routes);
      this.sync = {
        status: 'synced',
        lastSyncedAt: this.now().toISOString(),
      };
    } catch (error) {
      const message = errorMessage(error);
      console.warn(`[apps] Caddy reconciliation failed: ${message}`);
      this.sync = {
        status: 'error',
        ...(this.sync.lastSyncedAt !== undefined ? { lastSyncedAt: this.sync.lastSyncedAt } : {}),
        error: message,
      };
    }
  }

  private toAppInfo(record: PersistedAppRecord): AppInfo {
    return {
      slug: record.slug,
      title: record.title,
      ...(record.description !== undefined ? { description: record.description } : {}),
      ...(record.icon !== undefined ? { icon: record.icon } : {}),
      target: record.target,
      url: renderPublicUrl(this.config.publicUrlTemplate, record.slug),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.createdBySessionId !== undefined ? { createdBySessionId: record.createdBySessionId } : {}),
      ...(record.folderPath !== undefined ? { folderPath: record.folderPath } : {}),
    };
  }

  private emitChange(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (error) {
        console.error('[apps] Change listener threw:', error);
      }
    }
  }
}
