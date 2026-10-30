import { describe, expect, it } from 'vitest';
import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
import { GlobalSettingsStore } from './global-settings.svelte.js';

const agents = '/effective/agent/AGENTS.md';
const config = '/xdg/pimote/config.json';

function fixture() {
  let manifest = [
    { path: agents, label: 'AGENTS.md' },
    { path: config, label: 'config.json' },
  ];
  const disk = new Map<string, string>([
    [agents, '# Original\n'],
    [config, '{}\n'],
  ]);
  const reads: string[] = [];
  let failure: string | null = null;
  const send = async (command: PimoteCommand): Promise<PimoteResponse> => {
    if (command.type === 'file_get') {
      reads.push(command.path);
      if (failure) return { id: 'test', success: false, error: failure };
      return { id: 'test', success: true, data: { path: command.path, exists: disk.has(command.path), content: disk.get(command.path) ?? '' } };
    }
    if (command.type === 'file_put') {
      if (failure) return { id: 'test', success: false, error: failure };
      disk.set(command.path, command.content);
      return { id: 'test', success: true, data: { path: command.path } };
    }
    if (String(command.type) === 'get_global_settings') {
      return { id: 'test', success: true, data: { files: manifest.map((file) => ({ ...file })) } };
    }
    throw new Error(`Unexpected command: ${command.type}`);
  };
  const store = new GlobalSettingsStore(send);
  return {
    store,
    disk,
    reads,
    setManifest: (files: typeof manifest) => {
      manifest = files;
    },
    fail: (message: string) => {
      failure = message;
    },
  };
}

function file(store: GlobalSettingsStore, path: string) {
  const state = store.files.find((entry) => entry.path === path);
  if (!state) throw new Error(`Missing settings tab: ${path}`);
  return state;
}

describe('GlobalSettingsStore', () => {
  it('uses server-resolved paths and preserves the manifest until the next opening', async () => {
    const f = fixture();
    await f.store.loadManifest();
    f.setManifest([{ path: '/new/settings.json', label: 'settings.json' }]);
    await f.store.select(config);
    expect(f.store.files.map(({ path }) => path)).toEqual([agents, config]);
    f.store.close();
    await f.store.loadManifest();
    expect(f.store.files.map(({ path }) => path)).toEqual(['/new/settings.json']);
  });

  it('does not read an inactive file until its first selection', async () => {
    const f = fixture();
    await f.store.loadManifest();
    expect(f.reads).not.toContain(config);
    await f.store.select(config);
    expect(file(f.store, config).draft).toBe('{}\n');
    expect(f.reads).toContain(config);
  });

  it('preserves independent drafts and dirty markers across tab switches', async () => {
    const { store } = fixture();
    await store.loadManifest();
    await store.select(agents);
    store.edit(agents, '# Draft\n');
    await store.select(config);
    store.edit(config, '{"enabled":true}\n');
    await store.select(agents);
    expect(store.activePath).toBe(agents);
    expect(file(store, agents).draft).toBe('# Draft\n');
    expect(file(store, config).draft).toBe('{"enabled":true}\n');
    expect(file(store, agents).dirty).toBe(true);
    expect(file(store, config).dirty).toBe(true);
  });

  it('clears dirty state when a draft returns to its loaded contents', async () => {
    const { store } = fixture();
    await store.loadManifest();
    await store.select(agents);
    store.edit(agents, 'temporary');
    store.edit(agents, '# Original\n');
    expect(file(store, agents).dirty).toBe(false);
    expect(store.hasDirtyDrafts()).toBe(false);
  });

  it('saves complete contents for one file without saving other drafts or closing', async () => {
    const { store, disk } = fixture();
    await store.loadManifest();
    await store.select(agents);
    store.edit(agents, '# Saved\n');
    await store.select(config);
    store.edit(config, '{"unsaved":true}');
    expect(await store.save(agents)).toBe(true);
    expect(disk.get(agents)).toBe('# Saved\n');
    expect(disk.get(config)).toBe('{}\n');
    expect(file(store, agents).dirty).toBe(false);
    expect(file(store, config).dirty).toBe(true);
    expect(store.open).toBe(true);
  });

  it('opens a missing file empty and marks it created after a successful save', async () => {
    const { store, disk } = fixture();
    disk.delete(config);
    await store.loadManifest();
    await store.select(config);
    expect(file(store, config).exists).toBe(false);
    expect(file(store, config).draft).toBe('');
    store.edit(config, '{"created":true}');
    await store.save(config);
    expect(file(store, config).exists).toBe(true);
    expect(file(store, config).dirty).toBe(false);
    expect(disk.get(config)).toBe('{"created":true}');
  });

  it('retains the draft and dirty state after a rejected save', async () => {
    const f = fixture();
    await f.store.loadManifest();
    await f.store.select(agents);
    f.store.edit(agents, 'keep me');
    f.fail('Invalid configuration');
    expect(await f.store.save(agents)).toBe(false);
    expect(file(f.store, agents).draft).toBe('keep me');
    expect(file(f.store, agents).dirty).toBe(true);
    expect(file(f.store, agents).error).toContain('Invalid configuration');
    expect(f.disk.get(agents)).toBe('# Original\n');
  });

  it('does not overwrite a file after its load fails', async () => {
    const f = fixture();
    await f.store.loadManifest();
    f.fail('Read denied');
    await f.store.select(config);
    expect(file(f.store, config).loaded).toBe(false);
    expect(await f.store.save(config)).toBe(false);
    expect(f.disk.get(config)).toBe('{}\n');
  });

  it('requests one discard confirmation for dirty drafts in inactive tabs', async () => {
    const { store } = fixture();
    await store.loadManifest();
    await store.select(agents);
    store.edit(agents, 'unsaved');
    await store.select(config);
    store.close();
    store.close();
    expect(store.open).toBe(true);
    expect(store.discardConfirmation).toBe(true);
    store.keepEditing();
    expect(store.discardConfirmation).toBe(false);
    expect(file(store, agents).draft).toBe('unsaved');
    expect(store.open).toBe(true);
  });

  it('discards all drafts without writing when the user confirms close', async () => {
    const { store, disk } = fixture();
    await store.loadManifest();
    await store.select(agents);
    store.edit(agents, 'unsaved');
    store.close();
    store.discardAndClose();
    expect(store.open).toBe(false);
    expect(store.discardConfirmation).toBe(false);
    expect(store.hasDirtyDrafts()).toBe(false);
    expect(disk.get(agents)).toBe('# Original\n');
    await store.loadManifest();
    await store.select(agents);
    expect(file(store, agents).draft).toBe('# Original\n');
  });

  it('closes a clean opening without asking to discard', async () => {
    const { store } = fixture();
    await store.loadManifest();
    store.close();
    expect(store.open).toBe(false);
    expect(store.discardConfirmation).toBe(false);
  });
});
