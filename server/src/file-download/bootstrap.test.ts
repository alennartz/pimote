import { describe, expect, it, vi } from 'vitest';
import { bootstrapFileDownloads, type FileDownloadBootstrapDependencies } from './bootstrap.js';
import type { DownloadManager, DownloadStoreDocument } from './manager.js';
import type { SessionJsonStore } from '../session-json-store.js';

function makeStore(): SessionJsonStore<DownloadStoreDocument> {
  return {
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
  };
}

function makeManager(): DownloadManager {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    offer: vi.fn(),
    cancel: vi.fn(),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

function makeDependencies(): FileDownloadBootstrapDependencies & {
  gc: ReturnType<typeof vi.fn>;
  createStore: ReturnType<typeof vi.fn>;
  createManager: ReturnType<typeof vi.fn>;
  createExtension: ReturnType<typeof vi.fn>;
} {
  const store = makeStore();
  const manager = makeManager();
  const extensionFactory = (() => undefined) as any;
  return {
    gc: vi.fn(async () => undefined),
    createStore: vi.fn(() => store),
    createManager: vi.fn(() => manager),
    createExtension: vi.fn(() => extensionFactory),
  };
}

describe('bootstrapFileDownloads', () => {
  it('sweeps a successful session allow-list, then shares one manager between the extension and HTTP route resources', async () => {
    const dependencies = makeDependencies();
    const validSessionIds = new Set(['session-a']);

    const resources = await bootstrapFileDownloads({ storeDir: '/state/downloads', validSessionIds }, dependencies);

    expect(dependencies.gc).toHaveBeenCalledWith({ storeDir: '/state/downloads', validSessionIds });
    expect(dependencies.createStore).toHaveBeenCalledWith('/state/downloads');
    expect(dependencies.createManager).toHaveBeenCalledWith({ store: expect.any(Object) });
    expect(dependencies.createExtension).toHaveBeenCalledWith({ manager: resources.manager });
    expect(resources.extensionFactory).toBe(dependencies.createExtension.mock.results[0]?.value);
  });

  it('skips GC when session enumeration failed instead of treating all registrations as orphaned', async () => {
    const dependencies = makeDependencies();

    await bootstrapFileDownloads({ storeDir: '/state/downloads', validSessionIds: null }, dependencies);

    expect(dependencies.gc).not.toHaveBeenCalled();
    expect(dependencies.createStore).toHaveBeenCalledWith('/state/downloads');
  });
});
