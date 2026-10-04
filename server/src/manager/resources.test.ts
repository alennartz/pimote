import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagerResources, resetManagerResourceRoot } from './resources.js';
import { InMemoryStaticHostRegistry } from '../static-host/registry.js';
import { FileStaticHostStore } from '../static-host/store.js';
import { createDownloadManager, type DownloadStoreDocument } from '../file-download/manager.js';
import { FileSessionJsonStore } from '../session-json-store.js';

// Drive the same extension interface used by the manager runtime, with real
// registries and filesystem stores but no model or credentials.
function fakePi() {
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const api = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    events: { emit: vi.fn() },
  };
  return { tools, handlers, api };
}

describe('manager artifacts', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'manager-artifact-test-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const registry = new InMemoryStaticHostRegistry();
    const store = new FileStaticHostStore(join(root, 'hosts'));
    const downloadStore = new FileSessionJsonStore<DownloadStoreDocument>(join(root, 'downloads'));
    const downloads = createDownloadManager({ store: downloadStore });
    const resources = await createManagerResources({ root: join(root, 'artifacts'), registry, store, downloads, retentionMs: 1000 });
    const host = fakePi();
    const files = fakePi();
    await resources.extensionFactories[0](host.api as any);
    await resources.extensionFactories[1](files.api as any);
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'report'), { recursive: true });
    await writeFile(join(workspace, 'report', 'index.html'), '<h1>report</h1>');
    await writeFile(join(workspace, 'data.txt'), 'original');
    await symlink(join(workspace, 'data.txt'), join(workspace, 'report', 'asset.txt'));
    const ctx = { sessionManager: { getSessionId: () => 'manager-1' }, cwd: workspace };
    await files.handlers.get('session_start')!({}, ctx);
    async function offer() {
      await host.tools.get('pimote_static_host')!.execute('host', { slug: 'report', folder: join(workspace, 'report'), title: 'Report' }, undefined, undefined, ctx);
      await files.tools.get('pimote_send_file')!.execute('file', { path: 'data.txt' }, undefined, undefined, ctx);
      return downloads.snapshot('manager-1')[0];
    }
    async function disconnect() {
      await host.handlers.get('session_shutdown')!({}, ctx);
      await files.handlers.get('session_shutdown')!({}, ctx);
      resources.release('manager-1');
      await rm(workspace, { recursive: true, force: true });
    }
    return { registry, store, downloadStore, downloads, resources, host, files, ctx, workspace, offer, disconnect };
  }

  it('snapshots reports, symlinked assets and single-use downloads before workspace disposal', async () => {
    const fixture = await setup();
    try {
      const item = await fixture.offer();
      await writeFile(join(fixture.workspace, 'data.txt'), 'changed');
      await fixture.disconnect();
      const registration = fixture.registry.lookup('report')!;
      expect(await readFile(join(registration.folderPath, 'index.html'), 'utf8')).toBe('<h1>report</h1>');
      expect(await readFile(join(registration.folderPath, 'asset.txt'), 'utf8')).toBe('original');
      expect(fixture.host.api.events.emit).toHaveBeenCalledWith('pimote:panels', expect.objectContaining({ type: 'cards' }));
      const claim = await fixture.downloads.claim(item.id);
      expect(claim).toBeDefined();
      expect(await readFile(claim!.sourcePath, 'utf8')).toBe('original');
      expect(await fixture.downloads.claim(item.id)).toBeUndefined();
      expect(await fixture.downloadStore.read('manager-1')).toBeUndefined();
    } finally {
      await fixture.resources.discard('manager-1');
    }
  });

  it('expires retained capabilities, persisted metadata and snapshots after disconnect', async () => {
    const fixture = await setup();
    vi.useFakeTimers();
    try {
      const item = await fixture.offer();
      await fixture.disconnect();
      expect(fixture.registry.has('report')).toBe(true);
      expect(fixture.downloads.snapshot('manager-1')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.registry.has('report')).toBe(false);
      expect(await fixture.downloads.claim(item.id)).toBeUndefined();
      await vi.waitFor(async () => {
        expect(await readdir(join(root, 'artifacts'))).toEqual([]);
        expect(await fixture.store.read('manager-1')).toBeUndefined();
        expect(await fixture.downloadStore.read('manager-1')).toBeUndefined();
      });
    } finally {
      await fixture.resources.discard('manager-1');
    }
  });

  it('discards resources immediately when initialization fails', async () => {
    const fixture = await setup();
    const item = await fixture.offer();
    await fixture.resources.discard('manager-1');
    expect(fixture.registry.has('report')).toBe(false);
    expect(await fixture.downloads.claim(item.id)).toBeUndefined();
    expect(await readdir(join(root, 'artifacts'))).toEqual([]);
    expect(await fixture.store.read('manager-1')).toBeUndefined();
  });

  it('reclaims previous-boot artifact directories', async () => {
    const directory = join(root, 'artifacts');
    await mkdir(directory);
    await writeFile(join(directory, 'old'), 'stale');
    await resetManagerResourceRoot(directory);
    expect(await readdir(directory)).toEqual([]);
  });
});
