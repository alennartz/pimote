import { describe, it, expect, vi } from 'vitest';
import { createFileDownloadExtension } from './index.js';
import type { DownloadManager, DownloadUpdateEvent } from './manager.js';

interface FakePi {
  toolDefs: Array<{ name: string; description?: string; execute: (...args: any[]) => Promise<unknown> }>;
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

  it('describes explicit user approval and warns that the source stays available', async () => {
    const pi = makePi();
    const factory = createFileDownloadExtension({ manager: makeManager() });
    await factory(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_send_file');
    expect(tool?.description).toMatch(/download/i);
    expect(tool?.description).toMatch(/user|click|approval/i);
    expect(tool?.description).toMatch(/remain|available/i);
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
    expect(result).toBeTruthy();
  });

  it('passes session ownership into the cancel tool', async () => {
    const manager = makeManager();
    const pi = makePi();
    await createFileDownloadExtension({ manager })(pi.api);
    const tool = pi.toolDefs.find((candidate) => candidate.name === 'pimote_cancel_file_send')!;
    await tool.execute('call-2', { id: 'opaque-1' }, undefined, undefined, makeContext('session-1'));
    expect(manager.cancel).toHaveBeenCalledWith('session-1', 'opaque-1');
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
