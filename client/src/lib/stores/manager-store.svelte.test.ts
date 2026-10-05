import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ManagerStreamEvent, PimoteEvent } from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { createManagerStore, managerStore, type ManagerStore } from './manager-store.svelte.js';

/** Wrap a raw mapped session event (as the server does) with a foreign internal pi session id. */
function reduce(store: ManagerStore, event: Record<string, unknown>): void {
  store.handleManagerEvent({ type: 'manager_event', event: { sessionId: 'pi-internal-123', cursor: 0, ...event } as PimoteEvent } as ManagerStreamEvent);
}

function assistantMessage(text: string): PimoteEvent {
  return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as PimoteEvent;
}

describe('ManagerStore', () => {
  let store: ManagerStore;

  beforeEach(() => {
    store = createManagerStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Event reduction (via the session registry machinery)
  // --------------------------------------------------------------------------
  describe('event reduction', () => {
    it('starts idle with an empty transcript', () => {
      expect(store.status).toBe('idle');
      expect(store.messages).toEqual([]);
      expect(store.session).not.toBeNull();
    });

    it('reduces message_start/update/end into streaming and finalized messages', () => {
      reduce(store, { type: 'message_start', role: 'assistant' });
      // The wrapped event's internal pi session id is normalized onto the manager slot.
      expect(store.session!.streamingMessage).toEqual({ role: 'assistant', content: [] });

      reduce(store, { type: 'message_update', contentIndex: 0, subtype: 'start', content: { type: 'text', text: '' } });
      reduce(store, { type: 'message_update', contentIndex: 0, subtype: 'delta', content: { type: 'text', text: 'Hello ' } });
      reduce(store, { type: 'message_update', contentIndex: 0, subtype: 'delta', content: { type: 'text', text: 'world' } });
      expect(store.session!.streamingMessage!.content[0].text).toBe('Hello world');

      const final = assistantMessage('Hello world');
      reduce(store, { type: 'message_end', message: final });
      expect(store.messages).toEqual([final]);
      expect(store.session!.messageKeys).toHaveLength(1);
      expect(store.session!.streamingMessage).toBeNull();
      expect(store.session!.streamingKey).toBeNull();
    });

    it('agent_start → working; agent_end alone stays working; agent_settled → idle', () => {
      reduce(store, { type: 'agent_start' });
      expect(store.status).toBe('working');

      reduce(store, { type: 'agent_end' });
      // Terminal agent_end is a per-attempt content boundary, not the idle boundary.
      expect(store.status).toBe('working');

      reduce(store, { type: 'agent_settled' });
      expect(store.status).toBe('idle');
    });

    it('reduces tool execution events into toolExecutions', () => {
      reduce(store, { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'pimote_list_folders', args: {} });
      reduce(store, { type: 'tool_execution_update', toolCallId: 'tc1', content: 'listing…' });
      reduce(store, { type: 'tool_execution_end', toolCallId: 'tc1', result: '[]' });

      expect(store.session!.toolExecutions['tc1']).toEqual({
        name: 'pimote_list_folders',
        args: {},
        partialResult: 'listing…',
        status: 'completed',
        result: '[]',
      });
    });

    it('reduces report cards and download snapshots onto the manager slot', () => {
      const cards = [{ id: 'report', header: { title: 'Report' }, href: '/s/report/' }];
      const downloads = [{ id: 'file-1', filename: 'report.txt', sizeBytes: 12, href: '/d/file-1' }];
      reduce(store, { type: 'panel_update', cards });
      reduce(store, { type: 'download_update', cause: 'offered', offeredDownloadId: 'file-1', downloads });
      expect(store.session!.panelCards).toEqual(cards);
      expect(store.session!.downloads).toEqual(downloads);
      reduce(store, { type: 'download_update', cause: 'consumed', downloads: [] });
      expect(store.session!.downloads).toEqual([]);
      store.reset();
      expect(store.session!.panelCards).toEqual([]);
    });

    it('records the last bot activity timestamp from mapped events', () => {
      reduce(store, { type: 'message_end', message: assistantMessage('hi'), timestamp: '2026-04-04T12:00:00.000Z' });
      expect(store.session!.lastBotActivityTimestamp).toBe('2026-04-04T12:00:00.000Z');
    });
  });

  // --------------------------------------------------------------------------
  // Send / abort wiring
  // --------------------------------------------------------------------------
  describe('send / abort wiring', () => {
    it('send() issues manager_prompt with trimmed text and echoes it optimistically on success', async () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'cmd-1', success: true } as never);

      await store.send('  list folders  ');

      expect(send).toHaveBeenCalledWith({ type: 'manager_prompt', text: 'list folders' });
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
      expect(store.messages[0].content).toEqual([{ type: 'text', text: 'list folders' }]);
    });

    it('send() adds no echo when the server rejects the prompt', async () => {
      vi.spyOn(connection, 'send').mockResolvedValue({ id: 'cmd-2', success: false, error: 'manager busy' } as never);

      await store.send('hello');

      expect(store.messages).toEqual([]);
    });

    it('send() swallows a dropped socket and adds no echo', async () => {
      vi.spyOn(connection, 'send').mockRejectedValue(new Error('WebSocket not connected'));

      await expect(store.send('hello')).resolves.toBeUndefined();
      expect(store.messages).toEqual([]);
    });

    it('send() ignores empty or whitespace-only text', async () => {
      const send = vi.spyOn(connection, 'send');

      await store.send('');
      await store.send('   ');

      expect(send).not.toHaveBeenCalled();
    });

    it('abort() issues manager_abort', async () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'cmd-3', success: true } as never);

      await store.abort();

      expect(send).toHaveBeenCalledWith({ type: 'manager_abort' });
    });

    it('the canonical user message replaces the optimistic echo', async () => {
      vi.spyOn(connection, 'send').mockResolvedValue({ id: 'cmd-4', success: true } as never);
      await store.send('what can you do?');

      reduce(store, { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'what can you do?' }] } });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
      expect(store.session!.optimisticMessageKey).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Reset on disconnect
  // --------------------------------------------------------------------------
  describe('shared composer state', () => {
    it('hasConversation flips once a message lands', () => {
      expect(store.hasConversation).toBe(false);
      reduce(store, { type: 'message_end', message: assistantMessage('hi'), timestamp: '2026-04-04T12:00:00.000Z' });
      expect(store.hasConversation).toBe(true);
    });

    it('canSend requires draft text', () => {
      expect(store.canSend).toBe(false);
      store.draft = 'hello';
      expect(store.canSend).toBe(true);
    });

    it('sendDraft clears the composer and sends the trimmed text', async () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'cmd', success: true } as never);
      store.draft = '  do it  ';

      await store.sendDraft();

      expect(send).toHaveBeenCalledWith({ type: 'manager_prompt', text: 'do it' });
      expect(store.draft).toBe('');
      expect(store.canSend).toBe(false);
    });

    it('sendDraft ignores an empty or whitespace-only composer', async () => {
      const send = vi.spyOn(connection, 'send');
      store.draft = '   ';

      await store.sendDraft();

      expect(send).not.toHaveBeenCalled();
      expect(store.draft).toBe('   ');
    });
  });

  describe('reset on disconnect', () => {
    it('clears the transcript and returns to idle', () => {
      reduce(store, { type: 'agent_start' });
      reduce(store, { type: 'message_end', message: assistantMessage('partial answer') });
      expect(store.messages).toHaveLength(1);
      expect(store.status).toBe('working');

      store.reset();

      expect(store.messages).toEqual([]);
      expect(store.status).toBe('idle');
      expect(store.session!.messageKeys).toEqual([]);
    });

    it('a fresh state accepts new events after reset', () => {
      store.reset();

      reduce(store, { type: 'message_end', message: assistantMessage('again') });

      expect(store.messages).toHaveLength(1);
    });

    it('the store resets when the connection drops (onDisconnect wiring)', async () => {
      reduce(managerStore, { type: 'agent_start' });
      reduce(managerStore, { type: 'message_end', message: assistantMessage('stale transcript') });
      expect(managerStore.messages).toHaveLength(1);

      // Drive the production path: open the singleton's socket, then close it.
      // notifyDisconnected() runs the module-level onDisconnect wiring → reset.
      const sockets: FakeWebSocket[] = [];
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
        constructor() {
          sockets.push(this as FakeWebSocket);
        }
        send(): void {}
        close(): void {}
      }
      vi.stubGlobal('WebSocket', FakeWebSocket);
      // Node test environment: connect() only reads these two fields.
      vi.stubGlobal('location', { protocol: 'https:', host: 'test-host' });
      vi.useFakeTimers();
      try {
        connection.connect();
        sockets[0].onclose!();
        await vi.advanceTimersByTimeAsync(0);

        expect(managerStore.messages).toEqual([]);
        expect(managerStore.status).toBe('idle');
      } finally {
        connection.disconnect();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
  });
});
