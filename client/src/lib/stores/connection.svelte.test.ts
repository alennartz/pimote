import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionStore, connection, isSessionNotFoundError } from './connection.svelte.js';

// --- Fake WebSocket ---------------------------------------------------------
// connect() does `new WebSocket(...)` against the global and reads the
// CONNECTING/OPEN/CLOSING statics, so we stub the global with a controllable
// fake the test drives by hand (fire onopen/onclose, flip readyState).

const instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSING;
  }
}

/** Flush microtasks (and any setTimeout(0)) so promise chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Deliver the connect burst's user_sessions_changed so the restore dispatch
 *  runs. With `fresh: true` and no server sessions, the tab's local set is
 *  adopted — the pre-profile behavior the older tests rely on. */
const burst = (ws: FakeWebSocket, sessions: { sessionId: string; folderPath: string }[] = [], fresh = true) => {
  ws.onmessage!({ data: JSON.stringify({ type: 'user_sessions_changed', sessions, fresh }) });
};

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
  vi.stubGlobal('navigator', {});
  // window/document intentionally left unstubbed → installLifecycleListeners() bails.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectionStore — chunked event handling', () => {
  it('assembles full-resync chunks before exposing one snapshot event', async () => {
    const c = new ConnectionStore();
    const received: Array<{ type: string; messages?: unknown[] }> = [];
    c.onEvent((event) => received.push(event as { type: string; messages?: unknown[] }));
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    ws.onmessage!({ data: JSON.stringify({ type: 'full_resync_start', sessionId: 's1', snapshotId: 'snapshot-1', totalMessages: 2, totalBranchEntryIds: 2, state: {} }) });
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-1',
        offset: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
      }),
    });
    expect(received.filter((event) => event.type === 'full_resync')).toHaveLength(0);

    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-1',
        offset: 1,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'second' }] }],
      }),
    });
    expect(received.filter((event) => event.type === 'full_resync')).toHaveLength(0);
    ws.onmessage!({ data: JSON.stringify({ type: 'full_resync_branch_chunk', sessionId: 's1', snapshotId: 'snapshot-1', offset: 0, ids: ['entry-1', 'entry-2'] }) });
    const snapshots = received.filter((event) => event.type === 'full_resync');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.messages).toHaveLength(2);
    expect(received.some((event) => event.type.startsWith('full_resync_'))).toBe(false);
    c.disconnect();
  });

  it('parses serialized transcript fragments incrementally across frames', async () => {
    const c = new ConnectionStore();
    const received: Array<{ type: string; messages?: unknown[] }> = [];
    c.onEvent((event) => received.push(event as { type: string; messages?: unknown[] }));
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first 😀' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ];
    const serialized = JSON.stringify(messages);
    const boundary = serialized.indexOf('second');
    ws.onmessage!({ data: JSON.stringify({ type: 'full_resync_start', sessionId: 's1', snapshotId: 'snapshot-json', totalMessages: 2, state: {} }) });
    ws.onmessage!({
      data: JSON.stringify({ type: 'full_resync_json_chunk', sessionId: 's1', snapshotId: 'snapshot-json', offset: 0, data: serialized.slice(0, boundary), final: false }),
    });
    expect(received.filter((event) => event.type === 'full_resync')).toHaveLength(0);
    ws.onmessage!({
      data: JSON.stringify({ type: 'full_resync_json_chunk', sessionId: 's1', snapshotId: 'snapshot-json', offset: boundary, data: serialized.slice(boundary), final: true }),
    });

    const snapshot = received.find((event) => event.type === 'full_resync');
    expect(snapshot?.messages).toEqual(messages);
    c.disconnect();
  });

  it('assembles a large in-flight message before exposing the resync', async () => {
    const c = new ConnectionStore();
    const received: Array<{ type: string; streamingMessage?: unknown; activeSubagentContent?: unknown[]; runningToolCallIds?: string[] }> = [];
    c.onEvent((event) => received.push(event as { type: string; streamingMessage?: unknown; activeSubagentContent?: unknown[]; runningToolCallIds?: string[] }));
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    const streamingMessage = { role: 'assistant', content: [{ type: 'text', text: 'partial answer 😀' }] };
    const serialized = JSON.stringify(streamingMessage);
    const split = serialized.indexOf('answer');
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_start',
        sessionId: 's1',
        snapshotId: 'snapshot-stream',
        totalMessages: 0,
        hasStreamingMessage: true,
        hasActiveSubagentContent: true,
        hasRunningToolCallIds: true,
        state: {},
      }),
    });
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_data_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-stream',
        field: 'streamingMessage',
        offset: 0,
        data: serialized.slice(0, split),
        final: false,
      }),
    });
    expect(received.filter((event) => event.type === 'full_resync')).toHaveLength(0);
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_data_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-stream',
        field: 'streamingMessage',
        offset: split,
        data: serialized.slice(split),
        final: true,
      }),
    });
    expect(received.filter((event) => event.type === 'full_resync')).toHaveLength(0);
    const active = [
      {
        parentMessageId: 'message-0',
        contentIndex: 0,
        operationId: 'op-1',
        kind: 'send',
        data: { operation: 'send', parameters: { message: 'request' }, result: { response: '' } },
      },
    ];
    const activeJson = JSON.stringify(active);
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_data_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-stream',
        field: 'activeSubagentContent',
        offset: 0,
        data: activeJson,
        final: true,
      }),
    });
    const runningJson = JSON.stringify(['tool-1']);
    ws.onmessage!({
      data: JSON.stringify({
        type: 'full_resync_data_chunk',
        sessionId: 's1',
        snapshotId: 'snapshot-stream',
        field: 'runningToolCallIds',
        offset: 0,
        data: runningJson,
        final: true,
      }),
    });

    const completed = received.find((event) => event.type === 'full_resync');
    expect(completed?.streamingMessage).toEqual(streamingMessage);
    expect(completed?.activeSubagentContent).toEqual(active);
    expect(completed?.runningToolCallIds).toEqual(['tool-1']);
    c.disconnect();
  });

  it('dispatches event batches in order and advances each root cursor', async () => {
    const c = new ConnectionStore();
    const received: string[] = [];
    c.onEvent((event) => received.push(event.type));
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    ws.onmessage!({
      data: JSON.stringify({
        type: 'event_batch',
        events: [
          { type: 'message_update', sessionId: 's1', cursor: 4, subtype: 'delta', contentIndex: 0, content: { type: 'text', text: 'a' } },
          { type: 'message_update', sessionId: 's1', cursor: 5, subtype: 'delta', contentIndex: 0, content: { type: 'text', text: 'b' } },
        ],
      }),
    });
    expect(received).toEqual(['message_update', 'message_update']);
    expect(c.getRootCursor('s1')).toBe(5);
    c.disconnect();
  });
});

describe('ConnectionStore — definitive restore rejections', () => {
  /** Deliver the response to the first open_session the socket received. */
  const respondTo = (ws: FakeWebSocket, error: string) => {
    const openMsg = ws.sent.map((raw) => JSON.parse(raw) as { id: string; type: string }).find((m) => m.type === 'open_session')!;
    ws.onmessage!({ data: JSON.stringify({ id: openMsg.id, success: false, error }) });
  };

  it('session_not_found drops the subscription, notifies, and labels the sync', async () => {
    const c = new ConnectionStore();
    const onSessionNotFound = vi.fn(function captureDetail(this: void, _sid: string) {
      // Capture the label as the rejection lands, before the sync completes
      // and clears it.
      detailAtCallback = c.syncDetail;
    });
    let detailAtCallback: string | null | undefined;
    c.onSessionNotFound = onSessionNotFound;
    const onSessionRestoreFailed = vi.fn();
    c.onSessionRestoreFailed = onSessionRestoreFailed;
    c.addSubscribedSession('s-ghost', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    respondTo(ws, 'session_not_found');
    await flush();

    expect(onSessionNotFound).toHaveBeenCalledWith('s-ghost');
    expect(onSessionRestoreFailed).not.toHaveBeenCalled();
    expect(detailAtCallback).toBe('Session not found');
    expect(c.subscribedSessions.has('s-ghost')).toBe(false);
    expect(ws.sent.map((raw) => JSON.parse(raw)).some((command) => command.type === 'detach_session')).toBe(false);
    // The dropped session must not block the connection from becoming ready.
    expect(c.phase).toBe('ready');
    expect(c.ready).toBe(true);

    c.disconnect();
  });

  it.each(['boot', 'reconnect'])('%s archived rejection removes only the archived restore entry', async (mode) => {
    const c = new ConnectionStore();
    const deleted = vi.fn();
    c.onSessionNotFound = deleted;
    if (mode === 'reconnect') {
      c.connect();
      const initial = instances.at(-1)!;
      initial.readyState = FakeWebSocket.OPEN;
      initial.onopen!();
      burst(initial);
      await flush();
      c.disconnect();
    }
    c.addSubscribedSession('archived', '/proj');
    c.addSubscribedSession('retained', '/proj');
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();
    const opens = ws.sent.map((raw) => JSON.parse(raw)).filter((cmd) => cmd.type === 'open_session');
    expect(opens.every((cmd) => !('force' in cmd))).toBe(true);
    for (const cmd of opens) {
      ws.onmessage!({
        data: JSON.stringify(cmd.sessionId === 'archived' ? { id: cmd.id, success: false, error: 'session_archived' } : { id: cmd.id, success: true }),
      });
    }
    await flush();
    expect(c.subscribedSessions.has('archived')).toBe(false);
    expect(c.subscribedSessions.has('retained')).toBe(true);
    expect(ws.sent.map((raw) => JSON.parse(raw)).some((cmd) => cmd.type === 'detach_session')).toBe(false);
    expect(deleted).not.toHaveBeenCalled();
    expect(c.ready).toBe(true);
    c.disconnect();
  });

  it('non-definitive restore failures remove locally and show a small failure notice without detaching', async () => {
    const c = new ConnectionStore();
    const onSessionNotFound = vi.fn();
    const onSessionRestoreFailed = vi.fn();
    const events: any[] = [];
    c.onSessionNotFound = onSessionNotFound;
    c.onSessionRestoreFailed = onSessionRestoreFailed;
    c.onEvent((event) => events.push(event));
    c.addSubscribedSession('s-flaky', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    respondTo(ws, 'internal_error');
    await flush();

    expect(onSessionNotFound).not.toHaveBeenCalled();
    expect(onSessionRestoreFailed).toHaveBeenCalledWith('s-flaky');
    expect(c.subscribedSessions.has('s-flaky')).toBe(false);
    // No client-side detach: the command now unlinks the user everywhere, and
    // cleanup rests on the server's same-id takeover eviction (DR-067).
    expect(ws.sent.map((raw) => JSON.parse(raw)).some((command) => command.type === 'detach_session')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'extension_ui_request', sessionId: 's-flaky', method: 'notify', message: 'Session restore failed', notifyType: 'error' }),
    );

    c.disconnect();
  });

  it('isSessionNotFoundError accepts both the current and legacy error strings', () => {
    expect(isSessionNotFoundError('session_not_found')).toBe(true);
    expect(isSessionNotFoundError('session_expired')).toBe(true);
    expect(isSessionNotFoundError('session_archived')).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
  });
});

describe('ConnectionStore — archive notification', () => {
  it('drops an archived session from restores but ignores explicit unarchive', async () => {
    const c = new ConnectionStore();
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    await flush();
    c.addSubscribedSession('archived', '/proj');
    c.addSubscribedSession('retained', '/proj');
    ws.onmessage!({ data: JSON.stringify({ type: 'session_archived', sessionId: 'archived', folderPath: '/proj', archived: true }) });
    expect(c.subscribedSessions.has('archived')).toBe(false);
    expect(c.subscribedSessions.has('retained')).toBe(true);
    ws.onmessage!({ data: JSON.stringify({ type: 'session_archived', sessionId: 'archived', folderPath: '/proj', archived: false }) });
    expect(c.subscribedSessions.has('archived')).toBe(false);
    c.disconnect();
  });
});

describe('ConnectionStore — restore success', () => {
  /** Deliver a successful response to the first open_session the socket received. */
  const respondSuccessTo = (ws: FakeWebSocket, data: unknown) => {
    const openMsg = ws.sent.map((raw) => JSON.parse(raw) as { id: string; type: string }).find((m) => m.type === 'open_session')!;
    ws.onmessage!({ data: JSON.stringify({ id: openMsg.id, success: true, data }) });
  };

  it('passes the restore response to onSessionRestored so the registry can bind the folder row', async () => {
    const c = new ConnectionStore();
    const onSessionRestored = vi.fn();
    c.onSessionRestored = onSessionRestored;
    c.addSubscribedSession('s-1', '/repos/agent');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws);
    await flush();

    const payload = {
      sessionId: 's-1',
      folderPath: '/repos/agent',
      restoreMode: 'disk_full_resync',
      folder: { path: '/repos/agent', nature: 'persona', shortcutCount: 2 },
    };
    respondSuccessTo(ws, payload);
    await flush();

    expect(onSessionRestored).toHaveBeenCalledWith('s-1', payload);
    expect(c.phase).toBe('ready');

    c.disconnect();
  });
});

describe('ConnectionStore — socket identity guards', () => {
  it('symptom 1: a drop mid-restore does not mark the dead connection ready', async () => {
    const c = new ConnectionStore();
    const onReconnected = vi.fn();
    c.onReconnected = onReconnected;
    c.addSubscribedSession('s1', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    burst(ws); // fires restore (open_session) + schedules the Promise.all continuation

    // Socket drops while the restore is still in flight.
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose!(); // rejects pending → restore promise settles → backoff

    await flush(); // let the (now-stale) Promise.all continuation run

    expect(c.ready).toBe(false);
    expect(c.phase).toBe('backoff');
    expect(onReconnected).not.toHaveBeenCalled();

    c.disconnect(); // clear backoff timer/interval
  });

  it('symptom 2: a stale socket close does not clobber its replacement', async () => {
    const c = new ConnectionStore();

    c.connect();
    const ws1 = instances.at(-1)!;
    ws1.readyState = FakeWebSocket.OPEN;
    ws1.onopen!();
    const staleOnClose = ws1.onclose!; // capture before it's detached

    // Socket goes into CLOSING, then a reconnect builds a replacement.
    ws1.readyState = FakeWebSocket.CLOSING;
    c.connect();
    const ws2 = instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.readyState = FakeWebSocket.OPEN;
    ws2.onopen!();

    // The old socket's queued close event finally fires. It must NOT null the
    // live socket or reject the new connection's requests.
    staleOnClose();

    // Proof the live socket wasn't clobbered: a send is accepted (would reject
    // synchronously with "WebSocket not connected" if this.ws had been nulled).
    let rejected = false;
    c.send({ type: 'list_folders' } as never).catch(() => {
      rejected = true;
    });
    await flush();
    expect(rejected).toBe(false);
    expect(ws2.sent.length).toBe(1);

    c.disconnect();
  });
});

describe('duplicate-tab client id guard', () => {
  // Duplicating a tab copies sessionStorage. The tab that already holds the id
  // answers a newcomer's hello; the newcomer takes a fresh id.
  function nextMessage(channel: BroadcastChannel): Promise<{ type: string; id: string }> {
    return new Promise((resolve) => {
      channel.onmessage = (event) => resolve(event.data);
    });
  }

  it('defends its id against a newcomer that announces the same id', async () => {
    const other = new BroadcastChannel('pimote-client-id');
    const reply = nextMessage(other);
    other.postMessage({ type: 'hello', id: connection.clientId });
    expect(await reply).toEqual({ type: 'taken', id: connection.clientId });
    other.close();
  });

  it('takes a fresh id when another tab already holds it', async () => {
    const other = new BroadcastChannel('pimote-client-id');
    const before = connection.clientId;
    other.postMessage({ type: 'taken', id: before });
    await vi.waitFor(() => expect(connection.clientId).not.toBe(before));
    other.close();
  });
});
