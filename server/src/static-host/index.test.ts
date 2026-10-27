import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from 'typebox/value';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStaticHostRegistry } from './registry.js';
import { FileStaticHostStore } from './store.js';
import type { StaticHostStore } from './store.js';
import { createStaticHostExtension } from './index.js';
import { validateSlug } from './tools.js';
import type { Card } from '../../../shared/dist/index.js';

// --- Fake ExtensionAPI ----------------------------------------------------
//
// Enough surface for the static-host extension: `registerTool`, `on(...)`,
// `events.emit`. Each `on(event, handler)` records the handler so the test
// can drive it directly.

interface FakePi {
  toolDefs: Array<{
    name: string;
    execute: (...args: any[]) => any;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    exposure?: string;
    parameters: any;
  }>;
  handlers: Map<string, (event: any, ctx: any) => any>;
  emitted: Array<{ type: string; payload: unknown }>;
  api: any;
}

function makeFakePi(): FakePi {
  const fake: FakePi = { toolDefs: [], handlers: new Map(), emitted: [], api: null };
  fake.api = {
    registerTool(def: any) {
      fake.toolDefs.push(def);
    },
    on(event: string, handler: any) {
      fake.handlers.set(event, handler);
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    registerMessageRenderer() {},
    events: {
      emit(type: string, payload: unknown) {
        fake.emitted.push({ type, payload });
      },
      on() {
        return () => {};
      },
      off() {},
    },
  };
  return fake;
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

function makeCtx(sessionId: string) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    cwd: '/tmp',
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasUI: false,
    ui: {},
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  };
}

describe('createStaticHostExtension', () => {
  let root: string;
  let registry: InMemoryStaticHostRegistry;
  let store: FileStaticHostStore;
  let pi: FakePi;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'static-host-ext-'));
    registry = new InMemoryStaticHostRegistry();
    store = new FileStaticHostStore(join(root, 'store'));
    pi = makeFakePi();
    const factory = createStaticHostExtension({ registry, store });
    await factory(pi.api);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function bundle(name: string): Promise<string> {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'index.html'), '<h1>hi</h1>', 'utf-8');
    return folder;
  }

  function panelCards(): Card[] {
    const last = [...pi.emitted].reverse().find((e) => e.type === 'pimote:panels' && (e.payload as any)?.type === 'cards');
    return last ? ((last.payload as any).cards as Card[]) : [];
  }

  it('registers the register + remove tools', () => {
    const names = pi.toolDefs.map((t) => t.name).sort();
    expect(names).toEqual(['pimote_static_host', 'pimote_static_host_remove']);
  });

  it('exposes both tools directly with concise planner snippets and caller descriptions', () => {
    for (const tool of pi.toolDefs) {
      expect(tool.exposure).toBe('direct');
      const snippet = tool.promptSnippet ?? '';
      expect(snippet.trim().split(/\s+/).length).toBeGreaterThanOrEqual(5);
      expect(snippet.trim().split(/\s+/).length).toBeLessThanOrEqual(15);
      expect(snippet).not.toMatch(/[\r\n]/);
      expect(snippet).not.toContain(tool.name);
      const description = tool.description ?? '';
      expect(description.trim()).not.toBe('');
      expect(description.split(/[.!?]\s+/).length).toBeLessThanOrEqual(3);
    }
  });

  it('keeps report routing and ordering in named condition-first guidelines', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    const guidelines = tool.promptGuidelines ?? [];
    const guidance = guidelines.join('\n');
    expect(guidance).toMatch(/roughly 300\+ words.*several paragraphs.*multiple sections/);
    expect(guidance).toMatch(/visual or interactive answers, including compact reports/);
    expect(guidance).toMatch(/brief, unstructured text answers, use chat/);
    expect(guidance).toMatch(/without a separate permission request/);
    expect(guidance).toMatch(/one-to-three-sentence summary plus the card/);
    expect(guidance).toMatch(/Before authoring.*read the static report design guide.*<pimote-docs>/);
    expect(guidance).toMatch(/Before using.*free of secrets.*require authentication/);
    for (const guideline of guidelines) {
      expect(guideline).toMatch(/^(For|Before|After) /);
      expect(guideline).toContain('pimote_static_host');
      expect(guideline.split(/[.!?]\s+/)).toHaveLength(1);
    }
    expect(tool.description).not.toMatch(/300\+|permission|summary|design guide|secrets|1440px|line-height|prefers-color-scheme/i);
  });

  it('describes hosting results, collisions, live serving, cards, and immediate navigation', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    expect(tool.description).toContain('{slug,url}');
    expect(tool.description).toMatch(/already-hosted folder returns its existing slug and URL/);
    expect(tool.description).toMatch(/collisions change the returned slug/);
    expect(tool.description).toMatch(/verbatim.*source edits visible without rehosting/);
    expect(tool.description).toMatch(/session card.*immediate browser navigation/);
  });

  it('describes removal results and preserves the returned slug as the removal identifier', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host_remove')!;
    expect(tool.description).toContain('{removed}');
    expect(tool.description).toMatch(/source files intact/);
    expect(tool.description).toMatch(/false for unknown slugs.*another session/);
    expect(tool.parameters.properties.slug.description).toMatch(/Resolved slug returned by pimote_static_host/);
    expect(Value.Check(tool.parameters, { slug: `${'a'.repeat(64)}-2` })).toBe(true);
    expect(tool.promptGuidelines).toEqual([]);
  });

  it('states tag and color defaults without rejecting an empty tag', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    expect(tool.parameters.properties.tag.description).toMatch(/no tag displayed when omitted or empty/);
    expect(tool.parameters.properties.color.description).toMatch(/no override and an ordinary border when omitted/);
    expect(Value.Check(tool.parameters, { slug: 'report', folder: '/bundle', title: 'Report' })).toBe(true);
    expect(Value.Check(tool.parameters, { slug: 'report', folder: '/bundle', title: 'Report', tag: '' })).toBe(true);
  });

  it('declares slug validation that matches the runtime grammar and length limits', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    expect(tool.parameters.properties.slug).toMatchObject({
      description: expect.stringContaining('1–64 characters'),
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      minLength: 1,
      maxLength: 64,
    });
    for (const slug of ['a', 'demo-1', 'abc-def-2', 'a'.repeat(64), '', '-demo', 'demo-', 'demo--1', 'UPPER', 'has space', 'a'.repeat(65)]) {
      expect(Value.Check(tool.parameters, { slug, folder: '/bundle', title: 'Report' }), slug).toBe(validateSlug(slug) !== null);
    }
  });

  it('on session_start, replays persisted entries into the registry and emits panel cards', async () => {
    const folder = await bundle('persisted');
    await store.write('sess-X', {
      version: 1,
      entries: [{ slug: 'persisted', folderPath: folder, cardMetadata: { title: 'Persisted' } }],
    });

    const handler = pi.handlers.get('session_start');
    expect(handler).toBeDefined();
    await handler!({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));

    expect(registry.has('persisted')).toBe(true);
    expect(registry.lookup('persisted')?.sessionId).toBe('sess-X');
    expect(panelCards().some((c) => c.id.includes('persisted') || c.header.title === 'Persisted')).toBe(true);
  });

  it('on session_start with no persisted file, does nothing fatal and emits no entries', async () => {
    const handler = pi.handlers.get('session_start');
    await handler!({ type: 'session_start', reason: 'new' }, makeCtx('sess-fresh'));
    expect(registry.listForSession('sess-fresh')).toEqual([]);
  });

  it('replaying the same session twice does not create or erase its active registration', async () => {
    const folder = await bundle('replay-twice');
    await store.write('sess-X', {
      version: 1,
      entries: [{ slug: 'replay-twice', folderPath: folder, cardMetadata: { title: 'Replay twice' } }],
    });
    const handler = pi.handlers.get('session_start')!;

    await handler({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));
    await handler({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));

    expect(registry.listForSession('sess-X').map((entry) => entry.slug)).toEqual(['replay-twice']);
    expect((await store.read('sess-X'))?.entries.map((entry) => entry.slug)).toEqual(['replay-twice']);
  });

  it('serializes session replay with shutdown so shutdown leaves no active registration', async () => {
    const lifecycleRegistry = new InMemoryStaticHostRegistry();
    const lifecyclePi = makeFakePi();
    const readStarted = deferred();
    const releaseRead = deferred();
    const lifecycleStore: StaticHostStore = {
      async read(sessionId) {
        readStarted.resolve();
        await releaseRead.promise;
        return {
          version: 1,
          entries: [{ slug: 'lifecycle', folderPath: '/bundle', cardMetadata: { title: sessionId } }],
        };
      },
      async write() {},
      async remove() {},
    };
    await createStaticHostExtension({ registry: lifecycleRegistry, store: lifecycleStore })(lifecyclePi.api);

    const replay = lifecyclePi.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, makeCtx('sess-lifecycle'));
    await readStarted.promise;
    const shutdown = lifecyclePi.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, makeCtx('sess-lifecycle'));
    releaseRead.resolve();
    await Promise.all([replay, shutdown]);

    expect(lifecycleRegistry.has('lifecycle')).toBe(false);
  });

  it('on session_start, re-suffixes a slug already taken and rewrites the file (no phantom)', async () => {
    // Another session already owns the slug.
    const otherFolder = await bundle('taken-other');
    registry.register({ slug: 'taken', folderPath: otherFolder, sessionId: 'sess-other', cardMetadata: { title: 'Other' } });

    const folder = await bundle('taken-mine');
    await store.write('sess-X', {
      version: 1,
      entries: [{ slug: 'taken', folderPath: folder, cardMetadata: { title: 'Mine' } }],
    });

    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));

    // Re-suffixed registration owned by this session, reachable (not a phantom).
    expect(registry.has('taken-2')).toBe(true);
    expect(registry.lookup('taken-2')?.sessionId).toBe('sess-X');
    // File rewritten to the resolved slug, so the remove tool can match it and
    // it is not re-appended/duplicated on future writes.
    const file = await store.read('sess-X');
    expect(file?.entries.map((e) => e.slug)).toEqual(['taken-2']);

    const removeTool = pi.toolDefs.find((t) => t.name === 'pimote_static_host_remove')!;
    const out = await removeTool.execute('c', { slug: 'taken-2' }, undefined, undefined, makeCtx('sess-X'));
    expect((out.structuredContent as { removed: boolean }).removed).toBe(true);
  });

  it('on session_start, drops persisted entries for folders already active under another slug', async () => {
    const folder = await bundle('legacy-duplicates');
    await store.write('sess-X', {
      version: 1,
      entries: [
        { slug: 'legacy', folderPath: folder, cardMetadata: { title: 'Legacy' } },
        { slug: 'legacy-2', folderPath: join(folder, '..', 'legacy-duplicates'), cardMetadata: { title: 'Legacy copy' } },
      ],
    });

    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));

    expect(registry.listForSession('sess-X').map((entry) => entry.slug)).toEqual(['legacy']);
    expect((await store.read('sess-X'))?.entries.map((entry) => entry.slug)).toEqual(['legacy']);
  });

  function navigateEvents(): Array<{ url: string }> {
    return pi.emitted.filter((e) => e.type === 'pimote:navigate').map((e) => e.payload as { url: string });
  }

  it('the register tool emits a single navigate event with the resolved url', async () => {
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, makeCtx('sess-1'));
    const folder = await bundle('demo');
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    await tool.execute('call-1', { slug: 'demo', folder, title: 'Demo' }, undefined, undefined, makeCtx('sess-1'));
    expect(navigateEvents()).toEqual([{ url: '/s/demo/' }]);
  });

  it('session_start replay does not emit a navigate event', async () => {
    const folder = await bundle('persisted');
    await store.write('sess-X', {
      version: 1,
      entries: [{ slug: 'persisted', folderPath: folder, cardMetadata: { title: 'Persisted' } }],
    });
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, makeCtx('sess-X'));
    expect(navigateEvents()).toEqual([]);
  });

  it('the register tool registers, persists, and emits a card', async () => {
    // First boot the session.
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, makeCtx('sess-1'));

    const folder = await bundle('demo');
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    const result = await tool.execute('call-1', { slug: 'demo', folder, title: 'Demo' }, undefined, undefined, makeCtx('sess-1'));

    expect(result).toBeTruthy();
    expect(registry.has('demo')).toBe(true);
    const file = await store.read('sess-1');
    expect(file?.entries[0]?.slug).toBe('demo');

    const cards = panelCards();
    expect(cards.some((c) => c.header.title === 'Demo')).toBe(true);
    const demoCard = cards.find((c) => c.header.title === 'Demo')!;
    expect(demoCard.href).toBe('/s/demo/');
    expect(demoCard.header).not.toHaveProperty('tag');
    expect(demoCard).not.toHaveProperty('color');
  });

  it('the remove tool unregisters, persists, and re-emits the panel snapshot', async () => {
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, makeCtx('sess-1'));
    const folder = await bundle('demo');
    const reg = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    const remove = pi.toolDefs.find((t) => t.name === 'pimote_static_host_remove')!;

    await reg.execute('c1', { slug: 'demo', folder, title: 'Demo' }, undefined, undefined, makeCtx('sess-1'));
    const removeResult = await remove.execute('c2', { slug: 'demo' }, undefined, undefined, makeCtx('sess-1'));

    expect(removeResult).toBeTruthy();
    expect(registry.has('demo')).toBe(false);
    expect((await store.read('sess-1'))?.entries).toEqual([]);
    expect(panelCards().every((c) => c.header.title !== 'Demo')).toBe(true);
    expect(await readFile(join(folder, 'index.html'), 'utf-8')).toBe('<h1>hi</h1>');
  });

  it('on session_shutdown, releases all registrations owned by the session', async () => {
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, makeCtx('sess-1'));
    const folder = await bundle('demo');
    const reg = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    await reg.execute('c1', { slug: 'demo', folder, title: 'Demo' }, undefined, undefined, makeCtx('sess-1'));
    expect(registry.has('demo')).toBe(true);

    const shutdown = pi.handlers.get('session_shutdown');
    expect(shutdown).toBeDefined();
    await shutdown!({ type: 'session_shutdown', reason: 'quit' }, makeCtx('sess-1'));

    expect(registry.has('demo')).toBe(false);
  });

  it('leaves the persistence file on disk after shutdown (so the next session load can replay it)', async () => {
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, makeCtx('sess-1'));
    const folder = await bundle('demo');
    const reg = pi.toolDefs.find((t) => t.name === 'pimote_static_host')!;
    await reg.execute('c1', { slug: 'demo', folder, title: 'Demo' }, undefined, undefined, makeCtx('sess-1'));

    await pi.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, makeCtx('sess-1'));

    const persisted = await store.read('sess-1');
    expect(persisted?.entries).toHaveLength(1);
  });
});
