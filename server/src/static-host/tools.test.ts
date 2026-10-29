import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStaticHostRegistry } from './registry.js';
import { FileStaticHostStore } from './store.js';
import type { StaticHostStore, StaticHostStoreFile } from './store.js';
import { executeRegisterTool, executeRemoveTool, resolveSlugCollision, validateSlug, type ToolDeps } from './tools.js';

async function makeBundle(parent: string, name: string, { withIndex = true }: { withIndex?: boolean } = {}): Promise<string> {
  const folder = join(parent, name);
  await mkdir(folder, { recursive: true });
  if (withIndex) await writeFile(join(folder, 'index.html'), '<html></html>', 'utf-8');
  return folder;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cloneFile(file: StaticHostStoreFile | undefined): StaticHostStoreFile | undefined {
  return file ? { version: 1, entries: file.entries.map((entry) => ({ ...entry, cardMetadata: { ...entry.cardMetadata } })) } : undefined;
}

function makeMemoryStore(): StaticHostStore & { files: Map<string, StaticHostStoreFile> } {
  const files = new Map<string, StaticHostStoreFile>();
  return {
    files,
    async read(sessionId) {
      return cloneFile(files.get(sessionId));
    },
    async write(sessionId, file) {
      files.set(sessionId, cloneFile(file)!);
    },
    async remove(sessionId) {
      files.delete(sessionId);
    },
  };
}

describe('validateSlug', () => {
  it.each([['demo'], ['demo-1'], ['a'], ['abc-def-2'], ['report-2024-q4']])('accepts %p', (slug) => {
    expect(validateSlug(slug)).toBe(slug);
  });

  it.each([
    ['', 'empty string'],
    ['-leading', 'leading dash'],
    ['trailing-', 'trailing dash'],
    ['UPPER', 'uppercase'],
    ['has space', 'whitespace'],
    ['has/slash', 'path separator'],
    ['has.dot', 'dot'],
    ['emoji-\u{1F600}', 'non-ascii'],
  ])('rejects %p (%s)', (slug) => {
    expect(validateSlug(slug)).toBeNull();
  });

  it('rejects slugs over the length cap', () => {
    expect(validateSlug('a'.repeat(65))).toBeNull();
  });
});

describe('resolveSlugCollision', () => {
  it('returns the slug unchanged when free', () => {
    const r = new InMemoryStaticHostRegistry();
    expect(resolveSlugCollision('demo', r)).toBe('demo');
  });

  it('appends -2 when the base slug is taken', () => {
    const r = new InMemoryStaticHostRegistry();
    r.register({ slug: 'demo', folderPath: '/x', sessionId: 's', cardMetadata: { title: 'D' } });
    expect(resolveSlugCollision('demo', r)).toBe('demo-2');
  });

  it('appends increasing suffixes until a free slug is found', () => {
    const r = new InMemoryStaticHostRegistry();
    for (const [index, s] of ['demo', 'demo-2', 'demo-3'].entries()) {
      r.register({ slug: s, folderPath: `/x/${index}`, sessionId: 's', cardMetadata: { title: 'D' } });
    }
    expect(resolveSlugCollision('demo', r)).toBe('demo-4');
  });
});

describe('executeRegisterTool', () => {
  let root: string;
  let registry: InMemoryStaticHostRegistry;
  let store: FileStaticHostStore;
  let emitPanelCards: ReturnType<typeof vi.fn>;
  let emitNavigate: ReturnType<typeof vi.fn>;
  let deps: ToolDeps;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'static-host-tools-'));
    registry = new InMemoryStaticHostRegistry();
    store = new FileStaticHostStore(join(root, 'store'));
    emitPanelCards = vi.fn();
    emitNavigate = vi.fn();
    deps = { registry, store, sessionId: 'sess-1', emitPanelCards, emitNavigate };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('registers a valid bundle and returns the resolved slug + url', async () => {
    const folder = await makeBundle(root, 'demo');
    const out = await executeRegisterTool({ slug: 'demo', folder, title: 'Demo' }, deps);
    expect(out.slug).toBe('demo');
    expect(out.url).toBe('/s/demo/');
    expect(registry.has('demo')).toBe(true);
    const got = registry.lookup('demo');
    expect(got?.folderPath).toBe(folder);
    expect(got?.sessionId).toBe('sess-1');
    expect(got?.cardMetadata).toEqual({ title: 'Demo' });
  });

  it('persists the entry to the per-session store', async () => {
    const folder = await makeBundle(root, 'demo');
    await executeRegisterTool({ slug: 'demo', folder, title: 'Demo', tag: 'beta', color: 'accent' }, deps);
    const file = await store.read('sess-1');
    expect(file?.entries).toEqual([{ slug: 'demo', folderPath: folder, cardMetadata: { title: 'Demo', tag: 'beta', color: 'accent' } }]);
  });

  it('reuses an active registration for the same folder without rehosting', async () => {
    const folder = await makeBundle(root, 'demo');
    const first = await executeRegisterTool({ slug: 'demo', folder, title: 'Demo' }, deps);
    emitPanelCards.mockClear();
    emitNavigate.mockClear();

    const second = await executeRegisterTool({ slug: 'other-name', folder: join(folder, '..', 'demo'), title: 'Updated title' }, deps);

    expect(second).toMatchObject({
      slug: first.slug,
      url: first.url,
      alreadyHosted: true,
      message: expect.stringContaining(`Already hosted at ${first.url}`),
    });
    expect(second.message).toContain('reflects edits on the next request');
    expect(registry.listForSession('sess-1')).toHaveLength(1);
    expect((await store.read('sess-1'))?.entries).toHaveLength(1);
    expect(emitPanelCards).not.toHaveBeenCalled();
    expect(emitNavigate).not.toHaveBeenCalled();
  });

  it('reuses an active registration across sessions', async () => {
    const folder = await makeBundle(root, 'cross-session');
    const first = await executeRegisterTool({ slug: 'first', folder, title: 'First' }, deps);
    const otherPanel = vi.fn();
    const otherNavigate = vi.fn();
    const otherDeps: ToolDeps = { ...deps, sessionId: 'sess-2', emitPanelCards: otherPanel, emitNavigate: otherNavigate };

    const second = await executeRegisterTool({ slug: 'second', folder, title: 'Second' }, otherDeps);

    expect(second).toMatchObject({ slug: first.slug, url: first.url, alreadyHosted: true });
    expect(await store.read('sess-2')).toBeUndefined();
    expect(registry.listForSession('sess-1')).toHaveLength(1);
    expect(registry.listForSession('sess-2')).toHaveLength(0);
    expect(otherPanel).not.toHaveBeenCalled();
    expect(otherNavigate).not.toHaveBeenCalled();
  });

  it('emits panel cards exactly once on a successful register', async () => {
    const folder = await makeBundle(root, 'demo');
    await executeRegisterTool({ slug: 'demo', folder, title: 'Demo' }, deps);
    expect(emitPanelCards).toHaveBeenCalledTimes(1);
  });

  it('emits a navigate request with the resolved url on a successful register', async () => {
    const folder = await makeBundle(root, 'demo');
    const out = await executeRegisterTool({ slug: 'demo', folder, title: 'Demo' }, deps);
    expect(emitNavigate).toHaveBeenCalledTimes(1);
    expect(emitNavigate).toHaveBeenCalledWith(out.url);
    expect(out.url).toBe('/s/demo/');
  });

  it('emits the collision-suffixed url to navigate, not the requested slug', async () => {
    const f1 = await makeBundle(root, 'd1');
    const f2 = await makeBundle(root, 'd2');
    await executeRegisterTool({ slug: 'report', folder: f1, title: 'A' }, deps);
    emitNavigate.mockClear();
    await executeRegisterTool({ slug: 'report', folder: f2, title: 'B' }, deps);
    expect(emitNavigate).toHaveBeenCalledTimes(1);
    expect(emitNavigate).toHaveBeenCalledWith('/s/report-2/');
  });

  it('resolves slug collisions with -2, -3, ... suffix', async () => {
    const f1 = await makeBundle(root, 'd1');
    const f2 = await makeBundle(root, 'd2');
    const a = await executeRegisterTool({ slug: 'report', folder: f1, title: 'A' }, deps);
    const b = await executeRegisterTool({ slug: 'report', folder: f2, title: 'B' }, deps);
    expect(a.slug).toBe('report');
    expect(b.slug).toBe('report-2');
  });

  it('rejects an invalid slug', async () => {
    const folder = await makeBundle(root, 'demo');
    await expect(executeRegisterTool({ slug: 'Bad Slug', folder, title: 'X' }, deps)).rejects.toBeDefined();
    expect(registry.has('Bad Slug')).toBe(false);
  });

  it('reports the filesystem code when the folder does not exist', async () => {
    await expect(executeRegisterTool({ slug: 'demo', folder: join(root, 'nope'), title: 'X' }, deps)).rejects.toThrow(/ENOENT/);
  });

  it('reports the filesystem code when the folder has no index.html', async () => {
    const folder = await makeBundle(root, 'noindex', { withIndex: false });
    await expect(executeRegisterTool({ slug: 'demo', folder, title: 'X' }, deps)).rejects.toThrow(/ENOENT/);
  });

  it('does not mutate registry/store/panel emission on validation failure', async () => {
    await expect(executeRegisterTool({ slug: 'BAD', folder: '/nope', title: 'X' }, deps)).rejects.toBeDefined();
    expect(registry.listForSession('sess-1')).toEqual([]);
    expect(await store.read('sess-1')).toBeUndefined();
    expect(emitPanelCards).not.toHaveBeenCalled();
    expect(emitNavigate).not.toHaveBeenCalled();
  });

  it('serializes concurrent registrations through the file store without losing either entry', async () => {
    const firstFolder = await makeBundle(root, 'file-first');
    const secondFolder = await makeBundle(root, 'file-second');
    await Promise.all([
      executeRegisterTool({ slug: 'file-first', folder: firstFolder, title: 'First' }, deps),
      executeRegisterTool({ slug: 'file-second', folder: secondFolder, title: 'Second' }, deps),
    ]);

    const diskEntries = (await store.read('sess-1'))?.entries ?? [];
    const registryEntries = registry.listForSession('sess-1');
    expect(diskEntries).toHaveLength(2);
    expect(diskEntries.map((entry) => entry.slug)).toEqual(expect.arrayContaining(['file-first', 'file-second']));
    expect(registryEntries).toHaveLength(2);
    expect(registryEntries.map((entry) => entry.slug)).toEqual(expect.arrayContaining(['file-first', 'file-second']));
  });

  it('serializes concurrent registrations in one session without losing either entry', async () => {
    const memory = makeMemoryStore();
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const secondWriteStarted = deferred();
    let writes = 0;
    const gatedStore: StaticHostStore = {
      read: memory.read,
      remove: memory.remove,
      async write(sessionId, file) {
        writes += 1;
        if (writes === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        } else if (writes === 2) {
          secondWriteStarted.resolve();
        }
        await memory.write(sessionId, file);
      },
    };
    const firstFolder = await makeBundle(root, 'first');
    const secondFolder = await makeBundle(root, 'second');
    const first = executeRegisterTool({ slug: 'demo', folder: firstFolder, title: 'First' }, { ...deps, store: gatedStore });
    await firstWriteStarted.promise;
    const second = executeRegisterTool({ slug: 'demo', folder: secondFolder, title: 'Second' }, { ...deps, store: gatedStore });
    await Promise.race([secondWriteStarted.promise, new Promise((resolve) => setTimeout(resolve, 25))]);
    releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    expect((await memory.read('sess-1'))?.entries.map((entry) => entry.slug)).toEqual(['demo', 'demo-2']);
    expect(registry.listForSession('sess-1').map((entry) => entry.slug)).toEqual(['demo', 'demo-2']);
  });

  it('serializes same-slug registrations across sessions and assigns a distinct suffix', async () => {
    const memory = makeMemoryStore();
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const secondWriteStarted = deferred();
    let writes = 0;
    const gatedStore: StaticHostStore = {
      read: memory.read,
      remove: memory.remove,
      async write(sessionId, file) {
        writes += 1;
        if (writes === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        } else if (writes === 2) {
          secondWriteStarted.resolve();
        }
        await memory.write(sessionId, file);
      },
    };
    const firstFolder = await makeBundle(root, 'cross-first');
    const secondFolder = await makeBundle(root, 'cross-second');
    const first = executeRegisterTool({ slug: 'report', folder: firstFolder, title: 'First' }, { ...deps, store: gatedStore, sessionId: 'sess-1' });
    await firstWriteStarted.promise;
    const second = executeRegisterTool({ slug: 'report', folder: secondFolder, title: 'Second' }, { ...deps, store: gatedStore, sessionId: 'sess-2' });
    await Promise.race([secondWriteStarted.promise, new Promise((resolve) => setTimeout(resolve, 25))]);
    releaseFirstWrite.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(new Set([firstResult.slug, secondResult.slug])).toEqual(new Set(['report', 'report-2']));
    expect((await memory.read('sess-1'))?.entries.map((entry) => entry.slug)).toEqual([firstResult.slug]);
    expect((await memory.read('sess-2'))?.entries.map((entry) => entry.slug)).toEqual([secondResult.slug]);
    expect(registry.listForSession('sess-1').map((entry) => entry.slug)).toEqual([firstResult.slug]);
    expect(registry.listForSession('sess-2').map((entry) => entry.slug)).toEqual([secondResult.slug]);
  });

  it('serializes registration and removal so the removal sees the committed entry', async () => {
    const memory = makeMemoryStore();
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const gatedStore: StaticHostStore = {
      read: memory.read,
      remove: memory.remove,
      async write(sessionId, file) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        await memory.write(sessionId, file);
      },
    };
    const folder = await makeBundle(root, 'overlap');
    const register = executeRegisterTool({ slug: 'overlap', folder, title: 'Overlap' }, { ...deps, store: gatedStore });
    await firstWriteStarted.promise;
    const remove = executeRemoveTool({ slug: 'overlap' }, { ...deps, store: gatedStore });
    releaseFirstWrite.resolve();
    const [, removeResult] = await Promise.all([register, remove]);

    expect(removeResult).toEqual({ removed: true });
    expect(registry.has('overlap')).toBe(false);
    expect((await memory.read('sess-1'))?.entries).toEqual([]);
  });

  it('recovers the mutation queue after a store write failure', async () => {
    const memory = makeMemoryStore();
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const releaseSecondWrite = deferred();
    let writes = 0;
    const failingStore: StaticHostStore = {
      read: memory.read,
      remove: memory.remove,
      async write(sessionId, file) {
        writes += 1;
        if (writes === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
          throw new Error('injected write failure');
        }
        if (writes === 2) await releaseSecondWrite.promise;
        await memory.write(sessionId, file);
      },
    };
    const firstPanel = vi.fn();
    const firstFolder = await makeBundle(root, 'failed');
    const secondFolder = await makeBundle(root, 'recovered');
    const first = executeRegisterTool({ slug: 'retry', folder: firstFolder, title: 'Failed' }, { ...deps, store: failingStore, emitPanelCards: firstPanel });
    await firstWriteStarted.promise;
    const second = executeRegisterTool({ slug: 'retry', folder: secondFolder, title: 'Recovered' }, { ...deps, store: failingStore });
    releaseFirstWrite.resolve();
    await expect(first).rejects.toThrow('injected write failure');
    expect(registry.has('retry')).toBe(false);
    expect(firstPanel).not.toHaveBeenCalled();
    releaseSecondWrite.resolve();
    await expect(second).resolves.toMatchObject({ slug: 'retry' });
    expect(registry.lookup('retry')?.cardMetadata.title).toBe('Recovered');
  });
});

describe('executeRemoveTool', () => {
  let root: string;
  let registry: InMemoryStaticHostRegistry;
  let store: FileStaticHostStore;
  let emitPanelCards: ReturnType<typeof vi.fn>;
  let emitNavigate: ReturnType<typeof vi.fn>;
  let deps: ToolDeps;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'static-host-tools-rm-'));
    registry = new InMemoryStaticHostRegistry();
    store = new FileStaticHostStore(join(root, 'store'));
    emitPanelCards = vi.fn();
    emitNavigate = vi.fn();
    deps = { registry, store, sessionId: 'sess-1', emitPanelCards, emitNavigate };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes an entry owned by the session and reports removed:true', async () => {
    const folder = await makeBundle(root, 'demo');
    await executeRegisterTool({ slug: 'demo', folder, title: 'D' }, deps);
    emitPanelCards.mockClear();

    const out = await executeRemoveTool({ slug: 'demo' }, deps);
    expect(out.removed).toBe(true);
    expect(registry.has('demo')).toBe(false);
    expect((await store.read('sess-1'))?.entries).toEqual([]);
    expect(emitPanelCards).toHaveBeenCalledTimes(1);
  });

  it('returns removed:false when the slug is unknown', async () => {
    const out = await executeRemoveTool({ slug: 'ghost' }, deps);
    expect(out.removed).toBe(false);
    expect(emitPanelCards).not.toHaveBeenCalled();
  });

  it('returns removed:false when the slug is owned by a different session', async () => {
    const folder = await makeBundle(root, 'demo');
    await executeRegisterTool({ slug: 'demo', folder, title: 'D' }, deps);

    const otherDeps: ToolDeps = { ...deps, sessionId: 'sess-2', emitPanelCards: vi.fn(), emitNavigate: vi.fn() };
    const out = await executeRemoveTool({ slug: 'demo' }, otherDeps);
    expect(out.removed).toBe(false);
    expect(registry.has('demo')).toBe(true);
  });
});
