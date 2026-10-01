import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStaticHostRegistry } from './registry.js';
import { FileStaticHostStore } from './store.js';
import { createStaticHostExtension } from './index.js';
import { STATIC_REPORT_SKILL_NAME } from './skill.js';
import type { Card } from '../../../shared/dist/index.js';

// --- Fake ExtensionAPI ----------------------------------------------------
//
// Enough surface for the static-host extension: `registerTool`, `on(...)`,
// `events.emit`. Each `on(event, handler)` records the handler so the test
// can drive it directly.

interface FakePi {
  toolDefs: Array<{ name: string; execute: (...args: any[]) => any; description?: string }>;
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
    const factory = createStaticHostExtension({ registry, store, skillsDir: join(root, 'skills') });
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

  it('keeps the long-answer trigger always-on and defers layout detail to the skill', () => {
    const tool = pi.toolDefs.find((t) => t.name === 'pimote_static_host');
    const description = tool!.description as string;
    expect(description).toMatch(/300\+ words/i);
    expect(description).toMatch(/do not ask permission/i);
    expect(description).toMatch(/static-report.*skill/i);
    expect(description).toMatch(/secret/i);
    expect(description.trim().split(/\s+/).length).toBeLessThan(250);
    expect(description).not.toMatch(/1440px|line-height|prefers-color-scheme/i);
  });

  it('provides the report-design skill through resources_discover', async () => {
    const handler = pi.handlers.get('resources_discover');
    expect(handler).toBeDefined();
    const result = await handler!({ type: 'resources_discover', cwd: '/tmp', reason: 'startup' }, makeCtx('sess-X'));
    const skillFile = join(root, 'skills', STATIC_REPORT_SKILL_NAME, 'SKILL.md');
    expect(result).toEqual({ skillPaths: [skillFile] });
    const markdown = await readFile(skillFile, 'utf8');
    expect(markdown).toMatch(/Adaptive display — mandatory for mobile and desktop/);
    expect(markdown).toMatch(/~360px/);
    expect(markdown).toMatch(/~1440px/);
    expect(markdown).toMatch(/controls easy to tap/);
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
    expect((out.details as { removed: boolean }).removed).toBe(true);
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
