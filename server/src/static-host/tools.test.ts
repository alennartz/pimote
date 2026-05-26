import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStaticHostRegistry } from './registry.js';
import { FileStaticHostStore } from './store.js';
import { executeRegisterTool, executeRemoveTool, resolveSlugCollision, validateSlug, type ToolDeps } from './tools.js';

async function makeBundle(parent: string, name: string, { withIndex = true }: { withIndex?: boolean } = {}): Promise<string> {
  const folder = join(parent, name);
  await mkdir(folder, { recursive: true });
  if (withIndex) await writeFile(join(folder, 'index.html'), '<html></html>', 'utf-8');
  return folder;
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
    for (const s of ['demo', 'demo-2', 'demo-3']) {
      r.register({ slug: s, folderPath: '/x', sessionId: 's', cardMetadata: { title: 'D' } });
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

  it('rejects when the folder does not exist', async () => {
    await expect(executeRegisterTool({ slug: 'demo', folder: join(root, 'nope'), title: 'X' }, deps)).rejects.toBeDefined();
  });

  it('rejects when the folder has no index.html', async () => {
    const folder = await makeBundle(root, 'noindex', { withIndex: false });
    await expect(executeRegisterTool({ slug: 'demo', folder, title: 'X' }, deps)).rejects.toBeDefined();
  });

  it('does not mutate registry/store/panel emission on validation failure', async () => {
    await expect(executeRegisterTool({ slug: 'BAD', folder: '/nope', title: 'X' }, deps)).rejects.toBeDefined();
    expect(registry.listForSession('sess-1')).toEqual([]);
    expect(await store.read('sess-1')).toBeUndefined();
    expect(emitPanelCards).not.toHaveBeenCalled();
    expect(emitNavigate).not.toHaveBeenCalled();
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
