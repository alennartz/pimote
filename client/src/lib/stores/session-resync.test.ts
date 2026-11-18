import { afterEach, expect, it, vi } from 'vitest';
import type { FullResyncEvent, PimoteEvent, PimoteSurfaceEvent } from '@pimote/shared';
import { sendFullResync } from '../../../../server/src/session-resync.js';
import { ConnectionStore } from './connection.svelte.js';

const sockets: FakeSocket[] = [];
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

let connection: ConnectionStore | undefined;
afterEach(() => {
  connection?.disconnect();
  connection = undefined;
  vi.unstubAllGlobals();
  sockets.length = 0;
});

it.each(['root', 'child'] as const)('%s snapshots preserve large saved and live content across the wire', async (kind) => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
  vi.stubGlobal('navigator', {});
  const received: PimoteEvent[] = [];
  connection = new ConnectionStore();
  connection.onEvent((event) => received.push(event));
  connection.connect();
  const socket = sockets.at(-1)!;
  socket.onopen!();
  const receive = (event: PimoteEvent) => socket.onmessage!({ data: JSON.stringify(event) });
  receive({ type: 'user_sessions_changed', sessions: [], views: [], order: [], selectedSessionId: null, orderVersion: 0, fresh: true });
  await Promise.resolve();
  receive({ type: 'agent_start', sessionId: 'root', cursor: 11 });

  const prose = 'Keep the complete text 😀\n'.repeat(20_000);
  const sessionId = kind === 'root' ? 'root' : 'child';
  const snapshot: FullResyncEvent = {
    type: 'full_resync',
    sessionId,
    cursor: 100,
    state: {
      sessionId,
      sessionFile: undefined,
      model: { provider: 'test', id: 'model', name: 'Model' },
      thinkingLevel: 'high',
      availableThinkingLevels: ['off', 'high'],
      isStreaming: true,
      isCompacting: false,
      autoCompactionEnabled: true,
      messageCount: 1,
    },
    messages: [{ role: 'assistant', entryId: 'saved', content: [{ type: 'thinking', text: prose }] }],
    streamingMessage: { role: 'assistant', content: [{ type: 'text', text: prose }] },
    branchEntryIds: ['saved', 'hidden'],
    pendingSteeringMessages: ['queued question'],
    runningToolCallIds: ['bash-call'],
    activeSubagentContent: [
      {
        operationId: 'send-call',
        parentMessageId: 'saved',
        contentIndex: 1,
        kind: 'send',
        data: { operation: 'send', parameters: { to: ['worker'], message: prose }, result: { response: '', phase: 'sending' } },
      },
    ],
  };
  const frames: PimoteSurfaceEvent[] = [];
  sendFullResync(snapshot, (frame) => {
    frames.push(frame);
    return true;
  });
  const deliver = (frame: PimoteSurfaceEvent) =>
    receive(
      kind === 'root'
        ? frame
        : {
            type: 'subagent_view_event',
            sessionId: 'root',
            childSessionId: 'child',
            path: ['worker'],
            incarnation: 'inc',
            viewCursor: 100,
            event: frame,
          },
    );
  const snapshotType = kind === 'root' ? 'full_resync' : 'subagent_view_snapshot';
  for (const frame of frames.slice(0, -1)) deliver(frame);
  expect(received.some((event) => event.type === snapshotType)).toBe(false);
  deliver(frames.at(-1)!);
  const snapshots = received.filter((event) => event.type === snapshotType) as FullResyncEvent[];
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].messages[0].content[0].text).toBe(prose);
  expect(snapshots[0].streamingMessage?.content[0].text).toBe(prose);
  expect(snapshots[0].activeSubagentContent?.[0].data).toEqual(snapshot.activeSubagentContent![0].data);
  expect(snapshots[0].branchEntryIds).toEqual(['saved', 'hidden']);
  expect(snapshots[0].pendingSteeringMessages).toEqual(['queued question']);
  expect(snapshots[0].runningToolCallIds).toEqual(['bash-call']);
  expect(snapshots[0].state.thinkingLevel).toBe('high');
  expect(connection.getRootCursor('root')).toBe(kind === 'root' ? 100 : 11);
});
