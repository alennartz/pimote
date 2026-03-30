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
        makeSdkEvent('message_update', { content: { type: 'text', text: 'Hello ' } }),
        makeSdkEvent('message_update', { content: { type: 'text', text: 'world' } }),
        makeSdkEvent('message_update', { content: { type: 'text', text: '!' } }),
        makeSdkEvent('message_end', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] },
        }),
        makeSdkEvent('tool_execution_start', {
          toolName: 'read',
          toolCallId: 'tc-1',
          args: { path: '/foo' },
        }),
        makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', content: 'line 1\n' }),
        makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', content: 'line 2\n' }),
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
      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'text', text: 'hi' } }), SESSION_ID, sendLive);
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
      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'thinking', text: 'Let me think...' } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'text', text: 'The answer is 42' } }), SESSION_ID, sendLive);
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
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', content: 'file1\n' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', content: 'file2\n' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('tool_execution_update', { toolCallId: 'tc-1', content: 'file3\n' }), SESSION_ID, sendLive);
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

      expect(liveEvents[0]).toEqual({ type: 'agent_start', sessionId: SESSION_ID, cursor: 1 });
      expect(liveEvents[1]).toEqual({
        type: 'agent_end',
        sessionId: SESSION_ID,
        cursor: 2,
        error: 'something failed',
      });
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

      expect(liveEvents[0]).toEqual({
        type: 'extension_error',
        sessionId: SESSION_ID,
        cursor: 1,
        error: 'ext failed',
        extensionName: 'my-ext',
      });
    });

    it('maps message events with correct content', () => {
      const buffer = new EventBuffer(10);
      const liveEvents: PimoteSessionEvent[] = [];
      const sendLive = (e: PimoteSessionEvent) => liveEvents.push(e);

      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      expect((liveEvents[0] as any).role).toBe('assistant');

      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'text', text: 'hi' } }), SESSION_ID, sendLive);
      expect((liveEvents[1] as any).content).toEqual({ type: 'text', text: 'hi' });
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
      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'text', text: 'a' } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }), SESSION_ID, sendLive);

      // Second message
      buffer.onEvent(makeSdkEvent('message_start', { role: 'assistant' }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_update', { content: { type: 'text', text: 'b' } }), SESSION_ID, sendLive);
      buffer.onEvent(makeSdkEvent('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } }), SESSION_ID, sendLive);

      const replayed = buffer.replay(0);
      const types = replayed!.map((e) => e.type);
      expect(types).toEqual(['message_start', 'message_end', 'message_start', 'message_end']);
    });
  });
});
