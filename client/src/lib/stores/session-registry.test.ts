import { describe, it, expect, beforeEach } from 'vitest';
import type { PimoteEvent, PimoteAgentMessage } from '@pimote/shared';
import { SessionRegistry } from './session-registry.js';

function makeSessionEvent(type: string, sessionId: string, extra: Record<string, any> = {}): PimoteEvent {
  return { type, sessionId, cursor: 0, ...extra } as any;
}

function makeUserMessage(text: string): PimoteAgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function makeAssistantMessage(text: string): PimoteAgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  // --------------------------------------------------------------------------
  // Session Lifecycle
  // --------------------------------------------------------------------------
  describe('Session Lifecycle', () => {
    it('addSession() creates an entry with correct initial state', () => {
      registry.addSession('s1', '/home/user/projects/myapp', 'myapp');
      const session = registry.sessions.get('s1');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('s1');
      expect(session!.folderPath).toBe('/home/user/projects/myapp');
      expect(session!.projectName).toBe('myapp');
      expect(session!.status).toBe('idle');
      expect(session!.isStreaming).toBe(false);
      expect(session!.isCompacting).toBe(false);
      expect(session!.messages).toEqual([]);
      expect(session!.needsAttention).toBe(false);
      expect(session!.firstMessage).toBeUndefined();
      expect(session!.model).toBeNull();
      expect(session!.thinkingLevel).toBe('off');
      expect(session!.streamingText).toBe('');
      expect(session!.streamingThinking).toBe('');
      expect(session!.activeToolCalls.size).toBe(0);
      expect(session!.autoCompactionEnabled).toBe(false);
      expect(session!.messageCount).toBe(0);
    });

    it('addSession() with folderPath extracts projectName correctly', () => {
      registry.addSession('s1', '/home/user/repos/pimote', 'pimote');
      expect(registry.sessions.get('s1')!.projectName).toBe('pimote');
    });

    it('removeSession() deletes the entry', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.removeSession('s1');
      expect(registry.sessions.has('s1')).toBe(false);
    });

    it('removeSession() for unknown sessionId does nothing', () => {
      expect(() => registry.removeSession('nonexistent')).not.toThrow();
    });

    it('removeSession() for the viewed session sets viewedSessionId to null', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      expect(registry.viewedSessionId).toBe('s1');
      registry.removeSession('s1');
      expect(registry.viewedSessionId).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Viewed Session
  // --------------------------------------------------------------------------
  describe('Viewed Session', () => {
    it('viewed returns null when no session is viewed', () => {
      expect(registry.viewed).toBeNull();
    });

    it('viewed returns the correct session after switchTo()', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s2');
      expect(registry.viewed).toBe(registry.sessions.get('s2'));
    });

    it('switchTo() updates viewedSessionId', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      expect(registry.viewedSessionId).toBe('s1');
    });

    it('switchTo() clears needsAttention on the target session', () => {
      registry.addSession('s1', '/path', 'proj');
      // Simulate needsAttention being set (agent_end on non-viewed session)
      registry.addSession('s2', '/path2', 'proj2');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      expect(registry.sessions.get('s2')!.needsAttention).toBe(true);
      registry.switchTo('s2');
      expect(registry.sessions.get('s2')!.needsAttention).toBe(false);
    });

    it('switchTo() with unknown sessionId sets viewedSessionId (no error)', () => {
      expect(() => registry.switchTo('unknown')).not.toThrow();
      expect(registry.viewedSessionId).toBe('unknown');
    });
  });

  // --------------------------------------------------------------------------
  // Active Sessions
  // --------------------------------------------------------------------------
  describe('Active Sessions', () => {
    it('activeSessions returns empty array when no sessions exist', () => {
      expect(registry.activeSessions).toEqual([]);
    });

    it('activeSessions returns all sessions in the registry', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      expect(registry.activeSessions).toHaveLength(2);
      const ids = registry.activeSessions.map((s) => s.sessionId);
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Streaming State
  // --------------------------------------------------------------------------
  describe('Event Routing — Streaming State', () => {
    it('agent_start event sets session status to working and isStreaming to true', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      const session = registry.sessions.get('s1')!;
      expect(session.status).toBe('working');
      expect(session.isStreaming).toBe(true);
    });

    it('agent_end event sets session status to idle and isStreaming to false', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      const session = registry.sessions.get('s1')!;
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
    });

    it('events for unknown sessionId are ignored (no error)', () => {
      expect(() => registry.handleEvent(makeSessionEvent('agent_start', 'unknown'))).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Messages
  // --------------------------------------------------------------------------
  describe('Event Routing — Messages', () => {
    it('message_update with text content appends to streamingText', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'text', text: 'Hello ' },
      }));
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'text', text: 'world' },
      }));
      expect(registry.sessions.get('s1')!.streamingText).toBe('Hello world');
    });

    it('message_update with thinking content appends to streamingThinking', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'thinking', text: 'Let me ' },
      }));
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'thinking', text: 'think...' },
      }));
      expect(registry.sessions.get('s1')!.streamingThinking).toBe('Let me think...');
    });

    it('message_end appends message to messages array and clears streaming text', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'text', text: 'streaming...' },
      }));
      registry.handleEvent(makeSessionEvent('message_update', 's1', {
        content: { type: 'thinking', text: 'thinking...' },
      }));
      const msg = makeAssistantMessage('Final answer');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg }));
      const session = registry.sessions.get('s1')!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(msg);
      expect(session.streamingText).toBe('');
      expect(session.streamingThinking).toBe('');
    });

    it('message_end increments messageCount', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg1 = makeAssistantMessage('First');
      const msg2 = makeAssistantMessage('Second');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg1 }));
      expect(registry.sessions.get('s1')!.messageCount).toBe(1);
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg2 }));
      expect(registry.sessions.get('s1')!.messageCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Tool Calls
  // --------------------------------------------------------------------------
  describe('Event Routing — Tool Calls', () => {
    it('tool_execution_start adds entry to activeToolCalls', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('tool_execution_start', 's1', {
        toolCallId: 'tc1',
        toolName: 'read',
        args: { path: '/foo' },
      }));
      const calls = registry.sessions.get('s1')!.activeToolCalls;
      expect(calls.has('tc1')).toBe(true);
      expect(calls.get('tc1')!.name).toBe('read');
      expect(calls.get('tc1')!.args).toEqual({ path: '/foo' });
      expect(calls.get('tc1')!.partialResult).toBe('');
    });

    it('tool_execution_update appends to partialResult', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('tool_execution_start', 's1', {
        toolCallId: 'tc1',
        toolName: 'bash',
        args: {},
      }));
      registry.handleEvent(makeSessionEvent('tool_execution_update', 's1', {
        toolCallId: 'tc1',
        content: 'partial ',
      }));
      registry.handleEvent(makeSessionEvent('tool_execution_update', 's1', {
        toolCallId: 'tc1',
        content: 'result',
      }));
      expect(registry.sessions.get('s1')!.activeToolCalls.get('tc1')!.partialResult).toBe('partial result');
    });

    it('tool_execution_end removes entry from activeToolCalls', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('tool_execution_start', 's1', {
        toolCallId: 'tc1',
        toolName: 'bash',
        args: {},
      }));
      registry.handleEvent(makeSessionEvent('tool_execution_end', 's1', {
        toolCallId: 'tc1',
        result: 'done',
      }));
      expect(registry.sessions.get('s1')!.activeToolCalls.has('tc1')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Compaction
  // --------------------------------------------------------------------------
  describe('Event Routing — Compaction', () => {
    it('auto_compaction_start sets isCompacting to true', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('auto_compaction_start', 's1', { reason: 'threshold' }));
      expect(registry.sessions.get('s1')!.isCompacting).toBe(true);
    });

    it('auto_compaction_end sets isCompacting to false', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('auto_compaction_start', 's1', { reason: 'threshold' }));
      registry.handleEvent(makeSessionEvent('auto_compaction_end', 's1', {
        result: {},
        aborted: false,
        willRetry: false,
      }));
      expect(registry.sessions.get('s1')!.isCompacting).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Reconnect
  // --------------------------------------------------------------------------
  describe('Event Routing — Reconnect', () => {
    it('buffered_events processes each sub-event through handleEvent', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg = makeAssistantMessage('buffered msg');
      registry.handleEvent({
        type: 'buffered_events',
        sessionId: 's1',
        events: [
          { type: 'agent_start', sessionId: 's1', cursor: 1 },
          { type: 'message_end', sessionId: 's1', cursor: 2, message: msg } as any,
          { type: 'agent_end', sessionId: 's1', cursor: 3 },
        ],
      });
      const session = registry.sessions.get('s1')!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(msg);
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
    });

    it('full_resync replaces session state entirely', () => {
      registry.addSession('s1', '/path', 'proj');
      // Set some initial state
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      expect(registry.sessions.get('s1')!.isStreaming).toBe(true);

      const messages: PimoteAgentMessage[] = [
        makeUserMessage('Hello'),
        makeAssistantMessage('Hi there'),
      ];
      registry.handleEvent({
        type: 'full_resync',
        sessionId: 's1',
        state: {
          model: { provider: 'anthropic', id: 'claude-4', name: 'Claude 4' },
          thinkingLevel: 'high',
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 2,
        },
        messages,
      });
      const session = registry.sessions.get('s1')!;
      expect(session.isStreaming).toBe(false);
      expect(session.model).toEqual({ provider: 'anthropic', id: 'claude-4', name: 'Claude 4' });
      expect(session.thinkingLevel).toBe('high');
      expect(session.autoCompactionEnabled).toBe(true);
      expect(session.messageCount).toBe(2);
      expect(session.messages).toEqual(messages);
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Status Changes
  // --------------------------------------------------------------------------
  describe('Event Routing — Status Changes', () => {
    it('session_status_changed updates session status field', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_status_changed',
        sessionId: 's1',
        status: 'working',
      });
      expect(registry.sessions.get('s1')!.status).toBe('working');
      registry.handleEvent({
        type: 'session_status_changed',
        sessionId: 's1',
        status: 'idle',
      });
      expect(registry.sessions.get('s1')!.status).toBe('idle');
    });
  });

  // --------------------------------------------------------------------------
  // Needs Attention
  // --------------------------------------------------------------------------
  describe('Needs Attention', () => {
    it('needsAttention starts as false for new sessions', () => {
      registry.addSession('s1', '/path', 'proj');
      expect(registry.sessions.get('s1')!.needsAttention).toBe(false);
    });

    it('agent_end sets needsAttention=true when session is NOT the viewed session', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      expect(registry.sessions.get('s2')!.needsAttention).toBe(true);
    });

    it('agent_end does NOT set needsAttention when session IS the viewed session', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      expect(registry.sessions.get('s1')!.needsAttention).toBe(false);
    });

    it('switchTo() clears needsAttention', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      expect(registry.sessions.get('s2')!.needsAttention).toBe(true);
      registry.switchTo('s2');
      expect(registry.sessions.get('s2')!.needsAttention).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // First Message Tracking
  // --------------------------------------------------------------------------
  describe('First Message Tracking', () => {
    it('first message_end with role user captures firstMessage from the message text content', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg = makeUserMessage('What is the meaning of life?');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg }));
      expect(registry.sessions.get('s1')!.firstMessage).toBe('What is the meaning of life?');
    });

    it('firstMessage is not overwritten by subsequent user messages', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg1 = makeUserMessage('First question');
      const msg2 = makeUserMessage('Second question');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg1 }));
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg2 }));
      expect(registry.sessions.get('s1')!.firstMessage).toBe('First question');
    });
  });
});
