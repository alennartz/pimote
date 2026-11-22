import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppRouteReconciler } from './caddy-client.js';
import { AppService } from './service.js';
import { FileAppStore } from './store.js';
import type { AppRouteEntry, AppsConfig, AppsSnapshot } from './types.js';

class FakeReconciler implements AppRouteReconciler {
  lastRoutes: AppRouteEntry[] = [];
  failWith: Error | null = null;

  async reconcile(routes: readonly AppRouteEntry[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.lastRoutes = [...routes];
  }
}

const TEST_CONFIG: AppsConfig = {
  publicUrlTemplate: 'https://{slug}.apps.example.com',
  caddyAdminUrl: 'http://127.0.0.1:2019',
  caddyListen: '127.0.0.1:8080',
  caddyServerName: 'pimote_apps',
};

describe('AppService', () => {
  let dir: string;
  let storePath: string;
  let reconciler: FakeReconciler;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pimote-apps-'));
    storePath = join(dir, 'apps.json');
    reconciler = new FakeReconciler();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createService(): AppService {
    return new AppService({
      config: TEST_CONFIG,
      pimotePort: 3000,
      store: new FileAppStore(storePath),
      reconciler,
    });
  }

  it('persists registered apps across service restarts and reconciles routes to Caddy', async () => {
    const first = createService();
    await first.initialize();

    const registered = await first.register({
      slug: 'notes',
      title: 'Notes',
      description: 'Scratchpad',
      target: 'http://127.0.0.1:4173/',
      createdBySessionId: 'session-1',
      folderPath: '/srv/notes',
    });

    expect(registered.app).toMatchObject({
      slug: 'notes',
      title: 'Notes',
      description: 'Scratchpad',
      target: 'http://127.0.0.1:4173',
      url: 'https://notes.apps.example.com',
      createdBySessionId: 'session-1',
      folderPath: '/srv/notes',
    });
    expect(registered.sync.status).toBe('synced');
    expect(reconciler.lastRoutes).toEqual([{ slug: 'notes', hostname: 'notes.apps.example.com', target: 'http://127.0.0.1:4173' }]);

    // Reload into a brand-new AppService instance.
    reconciler.lastRoutes = [];
    const second = createService();
    const loaded = await second.initialize();
    expect(loaded.apps).toHaveLength(1);
    expect(loaded.apps[0]?.slug).toBe('notes');
    expect(reconciler.lastRoutes).toHaveLength(1);
  });

  it('rejects duplicate slugs unless overwrite is true', async () => {
    const service = createService();
    await service.initialize();
    await service.register({ slug: 'demo', title: 'Demo 1', target: 'http://127.0.0.1:4001' });

    await expect(service.register({ slug: 'demo', title: 'Demo 2', target: 'http://127.0.0.1:4002' })).rejects.toThrow(/already registered/);

    const replaced = await service.register({
      slug: 'demo',
      title: 'Demo 2',
      target: 'http://127.0.0.1:4002',
      overwrite: true,
    });
    expect(replaced.app.title).toBe('Demo 2');
    expect(replaced.app.target).toBe('http://127.0.0.1:4002');
  });

  it('updates metadata and target, removes apps, and notifies listeners', async () => {
    const service = createService();
    await service.initialize();

    const snapshots: AppsSnapshot[] = [];
    const unsubscribe = service.onChange((snap) => snapshots.push(snap));

    await service.register({ slug: 'alpha', title: 'Alpha', target: 'http://127.0.0.1:4100' });
    const updated = await service.update({ slug: 'alpha', title: 'Alpha v2', description: 'Updated', target: 'http://127.0.0.1:4101' });
    expect(updated.app).toMatchObject({ title: 'Alpha v2', description: 'Updated', target: 'http://127.0.0.1:4101' });

    expect(await service.remove('missing')).toMatchObject({ removed: false });
    expect(await service.remove('alpha')).toMatchObject({ removed: true });
    expect(service.list()).toEqual([]);
    expect(snapshots).toHaveLength(3);

    unsubscribe();
  });

  it('survives Caddy outage at boot and recovers on resync', async () => {
    const first = createService();
    await first.initialize();
    await first.register({ slug: 'tool', title: 'Tool', target: 'http://127.0.0.1:4200' });

    reconciler.failWith = new Error('connection refused');
    const second = createService();
    const boot = await second.initialize();
    expect(boot.apps).toHaveLength(1);
    expect(boot.sync.status).toBe('error');
    expect(boot.sync.error).toContain('connection refused');

    reconciler.failWith = null;
    const synced = await second.resync();
    expect(synced.sync.status).toBe('synced');
    expect(reconciler.lastRoutes).toHaveLength(1);
  });

  it('serializes concurrent registrations without losing records', async () => {
    const service = createService();
    await service.initialize();

    await Promise.all([
      service.register({ slug: 'app-a', title: 'App A', target: 'http://127.0.0.1:4301' }),
      service.register({ slug: 'app-b', title: 'App B', target: 'http://127.0.0.1:4302' }),
      service.register({ slug: 'app-c', title: 'App C', target: 'http://127.0.0.1:4303' }),
    ]);

    expect(service.list().map((app) => app.slug)).toEqual(['app-a', 'app-b', 'app-c']);
    expect(reconciler.lastRoutes).toHaveLength(3);
  });
});
