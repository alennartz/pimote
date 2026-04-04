import { describe, it, expect, vi } from 'vitest';
import { EventBuffer } from './event-buffer.js';
import type { PimoteSessionEvent } from '@pimote/shared';

describe('EventBuffer', () => {
  const SESSION_ID = 'test-session-1';

  function makeSdkEvent(type: string, extra: Record<string, any> = {}): { type: string; [key: string]: any } {
    return { type, ...extra };
  }

  describe('full event sequence', () => {
    it('forwards all events live and coalesces buffer correctly', () => {
      const buffer = new EventBuffer(100);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = vi.fn((event: PimoteSessionEvent) => {
        liveEvents.push(event);
      });

      // Feed a full sequence
      const events = [
        makeSdkEvent('agent_start'),
        makeSdkEvent('turn_start'),
        makeSdkEvent('message_start', { role: 'assistant' }),
        makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hello ', contentIndex: 0 } }),
        makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'world', contentIndex: 0 } }),
        makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '!', contentIndex: 0 } }),
        makeSdkEvent('message_end', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] },
        }),
        makeSdkEvent('tool_execution_start', {
          toolName: 'read',
          toolCallId: 'tc-1',
          args: { path: '/foo' },
        }),
        makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'line 1\n' }),
        makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'line 2\n' }),
        makeSdkEvent('tool_execution_end', { toolCallId: 'tc-1', result: 'done' }),
        makeSdkEvent('turn_end'),
        makeSdkEvent('agent_end'),
      ];

      for (const evt of events) {
        buffer.onEvent(evt, SESSION_ID, sendLive);
      }

      // All 13 events forwarded live
      expect(sendLive).toHaveBeenCalledTimes(13);
      expect(liveEvents).toHaveLength(13);

      // Verify live events have correct types and incrementing cursors
      expect(liveEvents[0].type).toBe('agent_start');
      expect(liveEvents[0].cursor).toBe(1);
      expect(liveEvents[12].type).toBe('agent_end');
      expect(liveEvents[12].cursor).toBe(13);

      // All events have the correct sessionId
      for (const evt of liveEvents) {
        expect(evt.sessionId).toBe(SESSION_ID);
      }

      // Replay from 0 — get all buffered events
      const replayed = buffer.replay(0);
      expect(replayed).not.toBeNull();
      expect(replayed).toBeDefined();

      // Buffer should NOT contain message_update or tool_execution_update
      const bufferedTypes = replayed!.map((e) => e.type);
      expect(bufferedTypes).not.toContain('message_update');
      expect(bufferedTypes).not.toContain('tool_execution_update');

      // Should contain: agent_start, turn_start, message_start, message_end,
      //                 tool_execution_start, tool_execution_end, turn_end, agent_end
      expect(bufferedTypes).toEqual(['agent_start', 'turn_start', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end']);
    });
  });

  describe('currentCursor', () => {
    it('starts at 0', () => {
      const buffer = new EventBuffer(10);
      expect(buffer.currentCursor).toBe(0);
    });

    it('increments with each event', () => {
      const buffer = new EventBuffer(10);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive);
      expect(buffer.currentCursor).toBe(1);

      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive);
      expect(buffer.currentCursor).toBe(2);

      // message_update also increments cursor (it's forwarded live, just not buffered)
      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hi', contentIndex: 0 } }), SESSION_ID, sendLive);
      expect(buffer.currentCursor).toBe(4);
    });
  });

  describe('replay', () => {
    it('returns correct subset when replaying from a mid-point cursor', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      // Push 5 directly-buffered events
      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 1
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 2
      buffer.onEvent(makeSdkEvent('turn_end'), SESSION_ID, sendLive); // cursor 3
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 4
      buffer.onEvent(makeSdkEvent('turn_end'), SESSION_ID, sendLive); // cursor 5

      // Replay from cursor 3 — should get events with cursor 4 and 5
      const replayed = buffer.replay(3);
      expect(replayed).toHaveLength(2);
      expect(replayed![0].cursor).toBe(4);
      expect(replayed![0].type).toBe('turn_start');
      expect(replayed![1].cursor).toBe(5);
      expect(replayed![1].type).toBe('turn_end');
    });

    it('returns empty array when client is caught up', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('agent_end'), SESSION_ID, sendLive);

      const replayed = buffer.replay(buffer.currentCursor);
      expect(replayed).toEqual([]);
    });

    it('returns empty array when fromCursor is ahead of currentCursor', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive);
      const replayed = buffer.replay(999);
      expect(replayed).toEqual([]);
    });

    it('returns null when fromCursor is too old (before oldest buffered)', () => {
      const buffer = new EventBuffer(3); // Small capacity
      const sendLive = vi.fn();

      // Fill and overflow
      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 1
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 2
      buffer.onEvent(makeSdkEvent('turn_end'), SESSION_ID, sendLive); // cursor 3
      buffer.onEvent(makeSdkEvent('agent_end'), SESSION_ID, sendLive); // cursor 4 — drops cursor 1

      // Replaying from cursor 0 — cursor 1 was dropped, can't guarantee completeness
      const replayed = buffer.replay(0);
      expect(replayed).toBeNull();
    });

    it('handles replay from cursor just before oldest buffered', () => {
      const buffer = new EventBuffer(3);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 1
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 2
      buffer.onEvent(makeSdkEvent('turn_end'), SESSION_ID, sendLive); // cursor 3
      buffer.onEvent(makeSdkEvent('agent_end'), SESSION_ID, sendLive); // cursor 4 — drops cursor 1

      // Oldest is now cursor 2. Replaying from cursor 1 means "give me everything after 1"
      // The oldest buffered cursor is 2, so fromCursor (1) = oldest cursor - 1: this is valid
      const replayed = buffer.replay(1);
      expect(replayed).not.toBeNull();
      expect(replayed).toHaveLength(3);
      expect(replayed![0].cursor).toBe(2);
      expect(replayed![2].cursor).toBe(4);
    });
  });

  describe('ring buffer overflow', () => {
    it('drops oldest events when capacity is exceeded', () => {
      const buffer = new EventBuffer(3);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 1
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 2
      buffer.onEvent(makeSdkEvent('turn_end'), SESSION_ID, sendLive); // cursor 3

      // Buffer is now full with cursors [1, 2, 3]
      let replayed = buffer.replay(0);
      expect(replayed).toHaveLength(3);

      // Add one more — cursor 1 drops
      buffer.onEvent(makeSdkEvent('agent_end'), SESSION_ID, sendLive); // cursor 4
      replayed = buffer.replay(1);
      expect(replayed).toHaveLength(3);
      expect(replayed![0].cursor).toBe(2);
      expect(replayed![1].cursor).toBe(3);
      expect(replayed![2].cursor).toBe(4);

      // Add two more — cursors 2 and 3 drop
      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 5
      buffer.onEvent(makeSdkEvent('turn_start'), SESSION_ID, sendLive); // cursor 6

      replayed = buffer.replay(3);
      expect(replayed).toHaveLength(3);
      expect(replayed![0].cursor).toBe(4);
      expect(replayed![1].cursor).toBe(5);
      expect(replayed![2].cursor).toBe(6);
    });

    it('handles capacity of 1', () => {
      const buffer = new EventBuffer(1);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive); // cursor 1
      buffer.onEvent(makeSdkEvent('agent_end'), SESSION_ID, sendLive); // cursor 2

      // Only cursor 2 should remain
      const replayed = buffer.replay(1);
      expect(replayed).toHaveLength(1);
      expect(replayed![0].cursor).toBe(2);

      // cursor 0 is too old
      expect(buffer.replay(0)).toBeNull();
    });
  });

  describe('coalescing with interleaved message and tool events', () => {
    it('handles thinking content accumulation', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think...', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'The answer is 42', contentIndex: 1 } }), SESSION_ID, sendLive);
      buffer.onEvent(
        makeSdkEvent('message_end', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'The answer is 42' }] },
        }),
        SESSION_ID,
        sendLive,
      );

      expect(sendLive).toHaveBeenCalledTimes(4);

      const replayed = buffer.replay(0);
      expect(replayed).toHaveLength(2); // message_start + message_end
      expect(replayed![0].type).toBe('message_start');
      expect(replayed![1].type).toBe('message_end');
    });

    it('coalesces multiple tool execution updates', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('tool_execution_start', { toolName: 'bash', toolCallId: 'tc-1', args: { cmd: 'ls' } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'file1\n' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'file2\n' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'file3\n' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_end', { toolCallId: 'tc-1', result: 'file1\nfile2\nfile3\n' }), SESSION_ID, sendLive);

      expect(sendLive).toHaveBeenCalledTimes(5);

      const replayed = buffer.replay(0);
      const types = replayed!.map((e) => e.type);
      expect(types).toEqual(['tool_execution_start', 'tool_execution_end']);
    });
  });

  describe('event mapping', () => {
    it('maps agent lifecycle events correctly', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('agent_start'), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('agent_end', { error: 'something failed' }), SESSION_ID, sendLive);

      expect(liveEvents[0]).toEqual(
        expect.objectContaining({
          type: 'agent_start',
          sessionId: SESSION_ID,
          cursor: 1,
        }),
      );
      expect(typeof (liveEvents[0] as any).timestamp).toBe('string');
      expect(liveEvents[1]).toEqual(
        expect.objectContaining({
          type: 'agent_end',
          sessionId: SESSION_ID,
          cursor: 2,
          error: 'something failed',
        }),
      );
      expect(typeof (liveEvents[1] as any).timestamp).toBe('string');
    });

    it('maps auto_compaction events correctly', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('auto_compaction_start', { reason: 'overflow' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('auto_compaction_end', { result: {}, aborted: false, willRetry: false }), SESSION_ID, sendLive);

      expect(liveEvents[0].type).toBe('auto_compaction_start');
      expect((liveEvents[0] as any).reason).toBe('overflow');
      expect(liveEvents[1].type).toBe('auto_compaction_end');
    });

    it('maps auto_retry events correctly', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'rate limit' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('auto_retry_end', { success: true, attempt: 1 }), SESSION_ID, sendLive);

      expect(liveEvents[0].type).toBe('auto_retry_start');
      expect((liveEvents[0] as any).attempt).toBe(1);
      expect(liveEvents[1].type).toBe('auto_retry_end');
      expect((liveEvents[1] as any).success).toBe(true);
    });

    it('maps extension_error events correctly', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('extension_error', { error: 'ext failed', extensionName: 'my-ext' }), SESSION_ID, sendLive);

      expect(liveEvents[0]).toEqual(
        expect.objectContaining({
          type: 'extension_error',
          sessionId: SESSION_ID,
          cursor: 1,
          error: 'ext failed',
          extensionName: 'my-ext',
        }),
      );
      expect(typeof (liveEvents[0] as any).timestamp).toBe('string');
    });

    it('maps text_delta with contentIndex and subtype', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      expect((liveEvents[0] as any).role).toBe('assistant');

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hi', contentIndex: 0 } }), SESSION_ID, sendLive);
      const update = liveEvents[1] as any;
      expect(update.content).toEqual({ type: 'text', text: 'hi' });
      expect(update.contentIndex).toBe(0);
      expect(update.subtype).toBe('delta');
    });

    it('maps thinking_delta with contentIndex and subtype', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me reason...', contentIndex: 0 } }), SESSION_ID, sendLive);
      const update = liveEvents[1] as any;
      expect(update.content).toEqual({ type: 'thinking', text: 'Let me reason...' });
      expect(update.contentIndex).toBe(0);
      expect(update.subtype).toBe('delta');
    });

    it('maps tool_execution_update with partialResult', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', partialResult: 'output line\n' }), SESSION_ID, sendLive);
      expect((liveEvents[0] as any).content).toBe('output line\n');
    });

    it('maps text_start with subtype start', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_start', contentIndex: 0 } }), SESSION_ID, sendLive);
      const update = liveEvents[0] as any;
      expect(update.subtype).toBe('start');
      expect(update.content).toEqual({ type: 'text', text: '' });
      expect(update.contentIndex).toBe(0);
    });

    it('maps text_end with subtype end', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_end', contentIndex: 0 } }), SESSION_ID, sendLive);
      const update = liveEvents[0] as any;
      expect(update.subtype).toBe('end');
      expect(update.content).toEqual({ type: 'text', text: '' });
    });

    it('maps thinking_start and thinking_end with correct subtypes', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }), SESSION_ID, sendLive);
      expect((liveEvents[0] as any).subtype).toBe('start');
      expect((liveEvents[0] as any).content).toEqual({ type: 'thinking', text: '' });

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 } }), SESSION_ID, sendLive);
      expect((liveEvents[1] as any).subtype).toBe('end');
      expect((liveEvents[1] as any).content).toEqual({ type: 'thinking', text: '' });
    });

    it('maps toolcall_start with tool metadata from partial message', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(
        makeSdkEvent('message_update', {
          assistantMessageEvent: {
            type: 'toolcall_start',
            contentIndex: 1,
            partial: {
              content: [{ type: 'text' }, { type: 'toolCall', id: 'tc-42', name: 'bash' }],
            },
          },
        }),
        SESSION_ID,
        sendLive,
      );

      const update = liveEvents[0] as any;
      expect(update.subtype).toBe('start');
      expect(update.contentIndex).toBe(1);
      expect(update.content).toEqual({ type: 'tool_call', text: '' });
      expect(update.toolCallId).toBe('tc-42');
      expect(update.toolName).toBe('bash');
    });

    it('maps toolcall_delta with tool_call content type', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(
        makeSdkEvent('message_update', {
          assistantMessageEvent: { type: 'toolcall_delta', delta: '{"command":', contentIndex: 1 },
        }),
        SESSION_ID,
        sendLive,
      );

      const update = liveEvents[0] as any;
      expect(update.subtype).toBe('delta');
      expect(update.contentIndex).toBe(1);
      expect(update.content).toEqual({ type: 'tool_call', text: '{"command":' });
      expect(update.toolCallId).toBeUndefined();
      expect(update.toolName).toBeUndefined();
    });

    it('maps toolcall_end with tool_call content type', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(
        makeSdkEvent('message_update', {
          assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1 },
        }),
        SESSION_ID,
        sendLive,
      );

      const update = liveEvents[0] as any;
      expect(update.subtype).toBe('end');
      expect(update.contentIndex).toBe(1);
      expect(update.content).toEqual({ type: 'tool_call', text: '' });
    });
  });

  describe('edge cases', () => {
    it('replay on empty buffer returns empty for fromCursor 0', () => {
      const buffer = new EventBuffer(10);
      // No events added, cursor is 0, fromCursor is 0 → caught up
      expect(buffer.replay(0)).toEqual([]);
    });

    it('handles multiple message sequences', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      // First message
      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'a', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }), SESSION_ID, sendLive);

      // Second message
      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'b', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } }), SESSION_ID, sendLive);

      const replayed = buffer.replay(0);
      const types = replayed!.map((e) => e.type);
      expect(types).toEqual(['message_start', 'message_end', 'message_start', 'message_end']);
    });
  });

  describe('interleaved content blocks', () => {
    it('forwards interleaved thinking, text, and tool_call blocks with correct contentIndex', () => {
      const buffer = new EventBuffer(100);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      // Simulate: thinking (index 0) → text (index 1) → tool_call (index 2)
      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm...', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 } }), SESSION_ID, sendLive);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_start', contentIndex: 1 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Let me read that file.', contentIndex: 1 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_end', contentIndex: 1 } }), SESSION_ID, sendLive);

      buffer.onEvent(
        makeSdkEvent('message_update', {
          assistantMessageEvent: {
            type: 'toolcall_start',
            contentIndex: 2,
            partial: { content: [{ type: 'thinking' }, { type: 'text' }, { type: 'toolCall', id: 'tc-1', name: 'read' }] },
          },
        }),
        SESSION_ID,
        sendLive,
      );
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":"/foo"}', contentIndex: 2 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2 } }), SESSION_ID, sendLive);

      buffer.onEvent(
        makeSdkEvent('message_end', {
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'Hmm...' },
              { type: 'text', text: 'Let me read that file.' },
              { type: 'tool_call', toolCallId: 'tc-1', toolName: 'read', args: { path: '/foo' } },
            ],
          },
        }),
        SESSION_ID,
        sendLive,
      );

      // 1 message_start + 9 message_update + 1 message_end = 11
      expect(liveEvents).toHaveLength(11);

      // Verify contentIndex is correct on each update
      const updates = liveEvents.filter((e) => e.type === 'message_update') as any[];
      expect(updates).toHaveLength(9);

      // Thinking block at index 0
      expect(updates[0].contentIndex).toBe(0);
      expect(updates[0].content.type).toBe('thinking');
      expect(updates[0].subtype).toBe('start');

      expect(updates[1].contentIndex).toBe(0);
      expect(updates[1].content.type).toBe('thinking');
      expect(updates[1].subtype).toBe('delta');
      expect(updates[1].content.text).toBe('Hmm...');

      expect(updates[2].contentIndex).toBe(0);
      expect(updates[2].subtype).toBe('end');

      // Text block at index 1
      expect(updates[3].contentIndex).toBe(1);
      expect(updates[3].content.type).toBe('text');
      expect(updates[3].subtype).toBe('start');

      expect(updates[4].contentIndex).toBe(1);
      expect(updates[4].content.type).toBe('text');
      expect(updates[4].content.text).toBe('Let me read that file.');

      // Tool call at index 2
      expect(updates[6].contentIndex).toBe(2);
      expect(updates[6].content.type).toBe('tool_call');
      expect(updates[6].subtype).toBe('start');
      expect(updates[6].toolCallId).toBe('tc-1');
      expect(updates[6].toolName).toBe('read');

      expect(updates[7].contentIndex).toBe(2);
      expect(updates[7].content.type).toBe('tool_call');
      expect(updates[7].content.text).toBe('{"path":"/foo"}');

      // Buffer should only contain message_start and message_end
      const replayed = buffer.replay(0);
      const types = replayed!.map((e) => e.type);
      expect(types).toEqual(['message_start', 'message_end']);
    });

    it('coalesces per contentIndex across interleaved blocks', () => {
      const buffer = new EventBuffer(100);
      const sendLive = vi.fn();

      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);

      // Thinking at index 0
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'part1 ', contentIndex: 0 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'part2', contentIndex: 0 } }), SESSION_ID, sendLive);

      // Text at index 1
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hello ', contentIndex: 1 } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'world', contentIndex: 1 } }), SESSION_ID, sendLive);

      buffer.onEvent(
        makeSdkEvent('message_end', {
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'part1 part2' },
              { type: 'text', text: 'hello world' },
            ],
          },
        }),
        SESSION_ID,
        sendLive,
      );

      // All deltas sent live
      expect(sendLive).toHaveBeenCalledTimes(6);

      // Only message_start and message_end in replay buffer
      const replayed = buffer.replay(0);
      expect(replayed!.map((e) => e.type)).toEqual(['message_start', 'message_end']);
    });

    it('defaults contentIndex to 0 when assistantMessageEvent lacks it', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }), SESSION_ID, sendLive);
      expect((liveEvents[0] as any).contentIndex).toBe(0);
    });

    it('defaults to text type and delta subtype when assistantMessageEvent is missing', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_update', {}), SESSION_ID, sendLive);
      const update = liveEvents[0] as any;
      expect(update.contentIndex).toBe(0);
      expect(update.subtype).toBe('delta');
      expect(update.content).toEqual({ type: 'text', text: '' });
    });
  });
});
