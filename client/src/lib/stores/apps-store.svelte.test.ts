import { describe, expect, it, vi } from 'vitest';
import type { AppInfo, PimoteCommand, PimoteResponse } from '@pimote/shared';
import { AppsStore } from './apps-store.svelte.js';

const SAMPLE_APP: AppInfo = {
  slug: 'notes',
  title: 'Notes',
  description: 'Personal notes',
  target: 'http://127.0.0.1:4173',
  url: 'https://notes.apps.example.com',
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

describe('AppsStore', () => {
  it('loads apps and updates live from apps_changed events', async () => {
    const send = vi.fn(async (cmd: PimoteCommand): Promise<PimoteResponse> => {
      if (cmd.type === 'list_apps') {
        return { id: '1', success: true, data: { apps: [SAMPLE_APP], sync: { status: 'synced' } } };
      }
      return { id: '1', success: false, error: 'unexpected' };
    });

    const store = new AppsStore({ send });
    await store.ensureLoaded();
    expect(store.loaded).toBe(true);
    expect(store.apps).toEqual([SAMPLE_APP]);

    store.handleEvent({
      type: 'apps_changed',
      apps: [],
      sync: { status: 'error', error: 'Caddy offline' },
    });
    expect(store.apps).toEqual([]);
    expect(store.sync).toEqual({ status: 'error', error: 'Caddy offline' });
  });

  it('registers, updates, removes, and resyncs apps through transport', async () => {
    const send = vi.fn(async (cmd: PimoteCommand): Promise<PimoteResponse> => {
      switch (cmd.type) {
        case 'register_app':
          return { id: '1', success: true, data: { app: SAMPLE_APP, sync: { status: 'synced' } } };
        case 'update_app':
          return {
            id: '2',
            success: true,
            data: { app: { ...SAMPLE_APP, title: 'Notes Pro' }, sync: { status: 'synced' } },
          };
        case 'remove_app':
          return { id: '3', success: true, data: { removed: true, sync: { status: 'synced' } } };
        case 'resync_apps':
          return { id: '4', success: true, data: { sync: { status: 'synced', lastSyncedAt: '2026-06-01T11:00:00.000Z' } } };
        default:
          return { id: '0', success: false, error: 'unknown' };
      }
    });

    const store = new AppsStore({ send });
    const reg = await store.register({ slug: 'notes', title: 'Notes', target: 'http://127.0.0.1:4173' });
    expect(reg.ok).toBe(true);
    expect(store.apps).toHaveLength(1);

    const upd = await store.update({ slug: 'notes', title: 'Notes Pro' });
    expect(upd.ok).toBe(true);
    expect(store.apps[0]?.title).toBe('Notes Pro');

    const rem = await store.remove('notes');
    expect(rem).toEqual({ ok: true, removed: true });
    expect(store.apps).toEqual([]);

    const resync = await store.resync();
    expect(resync.ok).toBe(true);
    expect(store.sync.status).toBe('synced');
  });
});
