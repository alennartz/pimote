import type {
  AppInfo,
  AppsChangedEvent,
  AppsSyncState,
  ListAppsResponseData,
  PimoteCommand,
  PimoteResponse,
  RegisterAppResponseData,
  RemoveAppResponseData,
  ResyncAppsResponseData,
  UpdateAppResponseData,
} from '@pimote/shared';
import { connection } from './connection.svelte.js';

export interface AppsTransport {
  send(command: PimoteCommand): Promise<PimoteResponse>;
}

export interface RegisterAppFormInput {
  slug: string;
  title: string;
  target: string;
  description?: string;
  overwrite?: boolean;
}

export interface UpdateAppFormInput {
  slug: string;
  title?: string;
  description?: string;
  target?: string;
}

const DEFAULT_SYNC: AppsSyncState = { status: 'synced' };

export class AppsStore {
  apps = $state<AppInfo[]>([]);
  sync = $state<AppsSyncState>({ ...DEFAULT_SYNC });
  loaded = $state(false);
  loading = $state(false);
  resyncing = $state(false);
  error = $state<string | null>(null);

  private inflightLoad: Promise<void> | null = null;

  constructor(private readonly transport: AppsTransport) {}

  handleEvent(event: AppsChangedEvent): void {
    this.apps = [...event.apps];
    this.sync = { ...event.sync };
    this.loaded = true;
    this.error = null;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.inflightLoad) return this.inflightLoad;

    this.loading = true;
    this.error = null;
    const load = (async () => {
      try {
        const response = await this.transport.send({ type: 'list_apps' });
        const data = response.data as ListAppsResponseData | undefined;
        if (!response.success || !data) {
          this.error = response.error ?? 'Failed to load apps';
          return;
        }
        this.apps = [...data.apps];
        this.sync = { ...data.sync };
        this.loaded = true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
        this.inflightLoad = null;
      }
    })();

    this.inflightLoad = load;
    return load;
  }

  async register(input: RegisterAppFormInput): Promise<{ ok: true; app: AppInfo } | { ok: false; error: string }> {
    const response = await this.transport.send({
      type: 'register_app',
      slug: input.slug,
      title: input.title,
      target: input.target,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
    });
    const data = response.data as RegisterAppResponseData | undefined;
    if (!response.success || !data) {
      return { ok: false, error: response.error ?? 'Failed to register app' };
    }
    this.sync = { ...data.sync };
    this.upsertLocal(data.app);
    return { ok: true, app: data.app };
  }

  async update(input: UpdateAppFormInput): Promise<{ ok: true; app: AppInfo } | { ok: false; error: string }> {
    const response = await this.transport.send({
      type: 'update_app',
      slug: input.slug,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
    });
    const data = response.data as UpdateAppResponseData | undefined;
    if (!response.success || !data) {
      return { ok: false, error: response.error ?? 'Failed to update app' };
    }
    this.sync = { ...data.sync };
    this.upsertLocal(data.app);
    return { ok: true, app: data.app };
  }

  async remove(slug: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
    const response = await this.transport.send({
      type: 'remove_app',
      slug,
    });
    const data = response.data as RemoveAppResponseData | undefined;
    if (!response.success || !data) {
      return { ok: false, error: response.error ?? 'Failed to remove app' };
    }
    this.sync = { ...data.sync };
    if (data.removed) {
      this.apps = this.apps.filter((app) => app.slug !== slug);
    }
    return { ok: true, removed: data.removed };
  }

  async resync(): Promise<{ ok: true; sync: AppsSyncState } | { ok: false; error: string }> {
    this.resyncing = true;
    try {
      const response = await this.transport.send({ type: 'resync_apps' });
      const data = response.data as ResyncAppsResponseData | undefined;
      if (!response.success || !data) {
        return { ok: false, error: response.error ?? 'Failed to resync apps' };
      }
      this.sync = { ...data.sync };
      return { ok: true, sync: data.sync };
    } finally {
      this.resyncing = false;
    }
  }

  reset(): void {
    this.apps = [];
    this.sync = { ...DEFAULT_SYNC };
    this.loaded = false;
    this.loading = false;
    this.resyncing = false;
    this.error = null;
    this.inflightLoad = null;
  }

  private upsertLocal(app: AppInfo): void {
    const next = this.apps.filter((entry) => entry.slug !== app.slug);
    next.push(app);
    next.sort((a, b) => {
      const titleOrder = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      return titleOrder !== 0 ? titleOrder : a.slug.localeCompare(b.slug);
    });
    this.apps = next;
  }
}

export const appsStore = new AppsStore({
  send: (command) => connection.send(command),
});

connection.onEvent((event) => {
  if (event.type === 'apps_changed') {
    appsStore.handleEvent(event);
  }
});
