import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DownloadManager, DownloadStoreDocument, DownloadUpdateEvent, OfferDownloadInput } from './manager.js';
import { createDownloadManager } from './manager.js';
import type { SessionJsonStore } from '../session-json-store.js';

function makeStore(initial: Record<string, DownloadStoreDocument> = {}): SessionJsonStore<DownloadStoreDocument> & {
  documents: Record<string, DownloadStoreDocument>;
  writes: Array<{ sessionId: string; document: DownloadStoreDocument }>;
  removes: string[];
} {
  const store = {
    documents: structuredClone(initial),
    writes: [] as Array<{ sessionId: string; document: DownloadStoreDocument }>,
    removes: [] as string[],
    async read(sessionId: string) {
      return store.documents[sessionId] ? structuredClone(store.documents[sessionId]) : undefined;
    },
    async write(sessionId: string, document: DownloadStoreDocument) {
      store.documents[sessionId] = structuredClone(document);
      store.writes.push({ sessionId, document: structuredClone(document) });
    },
    async remove(sessionId: string) {
      delete store.documents[sessionId];
      store.removes.push(sessionId);
    },
  };
  return store;
}

const restoredDocument: DownloadStoreDocument = {
  version: 1,
  downloads: [
    {
      id: 'opaque-1',
      sourcePath: 'reports/report.pdf',
      workspaceRoot: '/workspace/project',
      filename: 'report.pdf',
      sizeBytes: 42,
    },
  ],
};

function makeOffer(workspaceRoot: string, overrides: Partial<OfferDownloadInput> = {}): OfferDownloadInput {
  return {
    sessionId: 'session-1',
    workspaceRoot,
    path: 'reports/report.pdf',
    ...overrides,
  };
}

describe('createDownloadManager', () => {
  let store: ReturnType<typeof makeStore>;
  let manager: DownloadManager;
  let fixtureRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'file-download-manager-'));
    workspaceRoot = join(fixtureRoot, 'workspace');
    const outsideRoot = join(fixtureRoot, 'outside');
    await mkdir(join(workspaceRoot, 'reports'), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'reports', 'report.pdf'), 'report', 'utf8');
    await writeFile(join(workspaceRoot, 'secret.txt'), 'secret', 'utf8');
    await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'reports', 'linked-secret.txt'));
    await symlink(join(workspaceRoot, 'secret.txt'), join(workspaceRoot, 'reports', 'linked-inside.txt'));
    store = makeStore({
      'session-1': {
        ...restoredDocument,
        downloads: [{ ...restoredDocument.downloads[0], workspaceRoot }],
      },
    });
    manager = createDownloadManager({ store });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('restores a session document and publishes one complete restored snapshot', async () => {
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();
    await manager.activate('session-1', publish);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: 'download_update',
      sessionId: 'session-1',
      cause: 'restored',
      downloads: [{ id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' }],
    });
  });

  it('publishes an empty restored snapshot when the session has no document', async () => {
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();
    await manager.activate('new-session', publish);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: 'download_update',
      sessionId: 'new-session',
      cause: 'restored',
      downloads: [],
    });
  });

  it('deactivation drops process ownership without deleting persistence', async () => {
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();
    await manager.activate('session-1', publish);
    manager.deactivate('session-1');
    expect(store.documents['session-1']).toEqual({
      ...restoredDocument,
      downloads: [{ ...restoredDocument.downloads[0], workspaceRoot }],
    });
    expect(store.removes).toEqual([]);
  });

  it('offers a relative regular file and returns a same-origin opaque href', async () => {
    const item = await manager.offer(makeOffer(workspaceRoot));
    expect(item.filename).toBe('report.pdf');
    expect(item.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(item.id).toBeTruthy();
    expect(item.href).toBe(`/d/${item.id}`);
  });

  it('accepts an absolute path only when it remains inside the captured workspace root', async () => {
    const item = await manager.offer(makeOffer(workspaceRoot, { path: join(workspaceRoot, 'reports', 'report.pdf') }));
    expect(item.filename).toBe('report.pdf');
  });

  it('publishes a complete offered snapshot after registering an active session', async () => {
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();
    await manager.activate('new-session', publish);
    publish.mockClear();

    const item = await manager.offer(makeOffer(workspaceRoot, { sessionId: 'new-session' }));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: 'download_update',
      sessionId: 'new-session',
      cause: 'offered',
      offeredDownloadId: item.id,
      downloads: [item],
    });
  });

  it('rejects a missing source path', async () => {
    await expect(manager.offer(makeOffer(workspaceRoot, { path: 'missing.bin' }))).rejects.toThrow();
  });

  it('rejects a directory instead of registering it as a file', async () => {
    await expect(manager.offer(makeOffer(workspaceRoot, { path: 'reports' }))).rejects.toThrow();
  });

  it('rejects a path that resolves outside the workspace root', async () => {
    await expect(manager.offer(makeOffer(workspaceRoot, { path: '../outside/secret.txt' }))).rejects.toThrow();
  });

  it('rejects a symlink whose real path escapes the workspace root', async () => {
    await expect(manager.offer(makeOffer(workspaceRoot, { path: 'reports/linked-secret.txt' }))).rejects.toThrow();
  });

  it('accepts a symlink whose real path remains inside the workspace root', async () => {
    const item = await manager.offer(makeOffer(workspaceRoot, { path: 'reports/linked-inside.txt' }));
    expect(item.id).toBeTruthy();
  });

  it('persists the lexical source, root, derived filename, size, and opaque id', async () => {
    const item = await manager.offer(makeOffer(workspaceRoot));
    const write = store.writes.at(-1);
    expect(write?.sessionId).toBe('session-1');
    expect(write?.document.downloads).toContainEqual({
      id: item.id,
      sourcePath: 'reports/report.pdf',
      workspaceRoot,
      filename: 'report.pdf',
      sizeBytes: item.sizeBytes,
    });
  });

  it('rehydrates an offered registration after the manager restarts', async () => {
    const item = await manager.offer(makeOffer(workspaceRoot, { sessionId: 'session-2' }));
    const restarted = createDownloadManager({ store });
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();

    await restarted.activate('session-2', publish);

    expect(restarted.snapshot('session-2')).toEqual([item]);
    expect(publish).toHaveBeenCalledWith({
      type: 'download_update',
      sessionId: 'session-2',
      cause: 'restored',
      downloads: [item],
    });
  });

  it('snapshot returns only the pending public items for an active requested session', async () => {
    await manager.activate('session-1', vi.fn());
    expect(manager.snapshot('session-1')).toEqual([{ id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' }]);
    expect(manager.snapshot('other-session')).toEqual([]);
  });

  it('cancel removes an owned registration, preserves its source, and publishes a revoked full snapshot', async () => {
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>();
    await manager.activate('session-1', publish);
    const result = await manager.cancel('session-1', 'opaque-1');
    expect(result).toEqual({ cancelled: true });
    await expect(access(join(workspaceRoot, 'reports', 'report.pdf'))).resolves.toBeUndefined();
    expect(publish).toHaveBeenLastCalledWith({
      type: 'download_update',
      sessionId: 'session-1',
      cause: 'revoked',
      downloads: [],
    });

    const restarted = createDownloadManager({ store });
    await restarted.activate('session-1', vi.fn());
    expect(restarted.snapshot('session-1')).toEqual([]);
  });

  it('cancel returns false for an unknown registration', async () => {
    await expect(manager.cancel('session-1', 'missing')).resolves.toEqual({ cancelled: false });
  });

  it('cancel returns false when another session tries to revoke the registration', async () => {
    await manager.activate('session-1', vi.fn());
    await expect(manager.cancel('session-2', 'opaque-1')).resolves.toEqual({ cancelled: false });
    expect(manager.snapshot('session-1')).toHaveLength(1);
  });

  it('claim returns a server-only claim and publishes consumed before resolving', async () => {
    const order: string[] = [];
    const publish = vi.fn<(event: DownloadUpdateEvent) => void>(() => order.push('published'));
    await manager.activate('session-1', publish);
    order.length = 0;
    publish.mockClear();
    const claimPromise = manager.claim('opaque-1').then((claim) => {
      order.push('resolved');
      return claim;
    });
    const claim = await claimPromise;
    expect(claim).toEqual({
      sessionId: 'session-1',
      sourcePath: 'reports/report.pdf',
      workspaceRoot,
      filename: 'report.pdf',
    });
    expect(order).toEqual(['published', 'resolved']);
    expect(publish).toHaveBeenLastCalledWith({
      type: 'download_update',
      sessionId: 'session-1',
      cause: 'consumed',
      downloads: [],
    });

    const restarted = createDownloadManager({ store });
    await restarted.activate('session-1', vi.fn());
    expect(restarted.snapshot('session-1')).toEqual([]);
  });

  it('rejects a claim when durable removal fails, so a route cannot obtain source details', async () => {
    const failingStore = makeStore({
      'session-1': {
        ...restoredDocument,
        downloads: [{ ...restoredDocument.downloads[0], workspaceRoot }],
      },
    });
    failingStore.write = async () => {
      throw new Error('durable removal failed');
    };
    failingStore.remove = async () => {
      throw new Error('durable removal failed');
    };
    const failingManager = createDownloadManager({ store: failingStore });
    await failingManager.activate('session-1', vi.fn());

    await expect(failingManager.claim('opaque-1')).rejects.toThrow('durable removal failed');
  });

  it('claim is single-use when two callers race for the same id', async () => {
    await manager.activate('session-1', vi.fn());
    const claims = await Promise.all([manager.claim('opaque-1'), manager.claim('opaque-1')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1);
  });

  it('claim returns undefined for an unknown or already-consumed id', async () => {
    await expect(manager.claim('missing')).resolves.toBeUndefined();
    await manager.activate('session-1', vi.fn());
    await manager.claim('opaque-1');
    await expect(manager.claim('opaque-1')).resolves.toBeUndefined();
  });
});
