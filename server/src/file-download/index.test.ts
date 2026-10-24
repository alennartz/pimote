import { describe, it, expect, vi } from 'vitest';
import { createFileDownloadExtension } from './index.js';
import type { DownloadManager, DownloadUpdateEvent } from './manager.js';

interface FakePi {
  toolDefs: Array<{
    name: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    exposure?: string;
    parameters: any;
    execute: (...args: any[]) => Promise<unknown>;
  }>;
  handlers: Map<string, (event: unknown, ctx: any) => unknown>;
  emitted: Array<{ type: string; payload: unknown }>;
  api: any;
}

function makePi(): FakePi {
  const fake: FakePi = { toolDefs: [], handlers: new Map(), emitted: [], api: undefined };
  fake.api = {
    registerTool(def: any) {
      fake.toolDefs.push(def);
    },
    on(event: string, handler: (event: unknown, ctx: any) => unknown) {
      fake.handlers.set(event, handler);
    },
    events: {
      emit(type: string, payload: unknown) {
        fake.emitted.push({ type, payload });
      },
    },
  };
  return fake;
}

function makeManager(): DownloadManager & {
  activate: ReturnType<typeof vi.fn>;
  deactivate: ReturnType<typeof vi.fn>;
  offer: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    activate: vi.fn(async (_sessionId: string, _publish: (event: DownloadUpdateEvent) => void) => {}),
    deactivate: vi.fn(),
    detach: vi.fn(),
    offer: vi.fn(async () => ({ id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    claim: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

function makeContext(sessionId = 'session-1', cwd = '/workspace/project') {
  return { sessionManager: { getSessionId: () => sessionId }, cwd };
}

describe('createFileDownloadExtension', () => {
  it('registers send and cancel tools with their stable names', async () => {
    const manager = makeManager();
    const pi = makePi();
    const factory = createFileDownloadExtension({ manager });
    await factory(pi.api);
    expect(pi.toolDefs.map((tool) => tool.name).sort()).toEqual(['pimote_cancel_file_send', 'pimote_send_file']);
  });

  it('exposes both tools directly with concise planner snippets and caller descriptions', async () => {
    const pi = makePi();
    await createFileDownloadExtension({ manager: makeManager() })(pi.api);
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

  it('describes user action, live reads, metadata without a URL, and no click wait', async () => {
    const pi = makePi();
    await createFileDownloadExtension({ manager: makeManager() })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_send_file')!;
    expect(tool.description).toMatch(/one-shot native browser download.*explicit user click or approval/);
    expect(tool.description).toContain('{id,filename,sizeBytes}');
    expect(tool.description).toMatch(/not a URL.*without waiting for a click/);
    expect(tool.description).toMatch(/reads the live source file when the user acts/);
    expect(tool.description).not.toMatch(/keep.*available|current working directory|absolute/);
    expect(tool.parameters.properties.path.description).toMatch(/absolute or relative to the current working directory/);
  });

  it('puts source preservation in a named condition-first planner guideline', async () => {
    const pi = makePi();
    await createFileDownloadExtension({ manager: makeManager() })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_send_file')!;
    expect(tool.promptGuidelines).toHaveLength(1);
    expect(tool.promptGuidelines?.[0]).toMatch(/^For pending pimote_send_file offers, keep their source files available and unchanged\.$/);
  });

  it('describes false cancellation results for unavailable or other-session offers', async () => {
    const pi = makePi();
    await createFileDownloadExtension({ manager: makeManager() })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_cancel_file_send')!;
    expect(tool.description).toContain('{cancelled}');
    expect(tool.description).toMatch(/false for unknown, consumed, previously cancelled, or other-session offers/);
    expect(tool.parameters.properties.id.description).toMatch(/id returned by pimote_send_file/);
    expect(tool.promptGuidelines).toEqual([]);
  });

  it('activates the owning session on session_start and publishes a restored snapshot event', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    const start = pi.handlers.get('session_start');
    expect(start).toBeDefined();
    await start!({ type: 'session_start' }, makeContext('session-9'));
    expect(manager.activate).toHaveBeenCalledWith('session-9', expect.any(Function));
  });

  it('forwards manager updates onto the dedicated EventBus channel', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    await pi.handlers.get('session_start')!({ type: 'session_start' }, makeContext('session-1'));
    const publish = manager.activate.mock.calls[0]?.[1] as (event: DownloadUpdateEvent) => void;
    const update: DownloadUpdateEvent = {
      type: 'download_update',
      sessionId: 'session-1',
      cause: 'offered',
      offeredDownloadId: 'opaque-1',
      downloads: [{ id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42, href: '/d/opaque-1' }],
    };
    publish(update);
    expect(pi.emitted).toContainEqual({ type: 'pimote:downloads', payload: update });
  });

  it('passes session id and cwd into the send tool and returns its registration', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_send_file')!;
    const result = await tool.execute('call-1', { path: 'report.pdf' }, undefined, undefined, makeContext('session-1', '/workspace/project'));
    expect(manager.offer).toHaveBeenCalledWith({ sessionId: 'session-1', workspaceRoot: '/workspace/project', path: 'report.pdf' });
    expect(result).toMatchObject({ structuredContent: { id: 'opaque-1', filename: 'report.pdf', sizeBytes: 42 } });
    expect((result as { structuredContent: Record<string, unknown> }).structuredContent).not.toHaveProperty('href');
  });

  it('passes session ownership into the cancel tool', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_cancel_file_send')!;
    await tool.execute('call-2', { id: 'opaque-1' }, undefined, undefined, makeContext('session-1'));
    expect(manager.cancel).toHaveBeenCalledWith('session-1', 'opaque-1');
  });

  it('snapshots the source before offering a manager download', async () => {
    const manager = makeManager();
    const pi = makePi();
    const preparePath = vi.fn(async () => '/artifacts/report.pdf');
    await createFileDownloadExtension({ manager, preparePath })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_send_file')!;
    await tool.execute('call-1', { path: 'report.pdf' }, undefined, undefined, makeContext());
    expect(preparePath).toHaveBeenCalledWith('report.pdf', '/workspace/project');
    expect(manager.offer).toHaveBeenCalledWith({ sessionId: 'session-1', workspaceRoot: '/workspace/project', path: '/artifacts/report.pdf' });
  });

  it('detaches manager shutdown without revoking links', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager, retainOnShutdown: true })(pi.api);
    await pi.handlers.get('session_shutdown')!({}, makeContext());
    expect(manager.detach).toHaveBeenCalledWith('session-1');
    expect(manager.deactivate).not.toHaveBeenCalled();
  });

  it('deactivates process ownership on session_shutdown while retaining persistence', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    const shutdown = pi.handlers.get('session_shutdown');
    expect(shutdown).toBeDefined();
    await shutdown!({ type: 'session_shutdown' }, makeContext('session-1'));
    expect(manager.deactivate).toHaveBeenCalledWith('session-1');
  });
});
