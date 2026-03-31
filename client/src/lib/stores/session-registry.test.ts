import { describe, it, expect, beforeEach } from 'vitest';
import type { PimoteEvent, PimoteAgentMessage } from '@pimote/shared';
import { SessionRegistry } from './session-registry.svelte.js';

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
      const session = registry.sessions['s1'];
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
      expect(session!.streamingMessage).toBeNull();
      expect(session!.streamingKey).toBeNull();
      expect(session!.messageKeys).toEqual([]);
      expect(Object.keys(session!.toolExecutions).length).toBe(0);
      expect(session!.autoCompactionEnabled).toBe(false);
      expect(session!.messageCount).toBe(0);
      expect(session!.conflictingProcesses).toEqual([]);
    });

    it('addSession() with folderPath extracts projectName correctly', () => {
      registry.addSession('s1', '/home/user/repos/pimote', 'pimote');
      expect(registry.sessions['s1'].projectName).toBe('pimote');
    });

    it('removeSession() deletes the entry', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.removeSession('s1');
      expect(registry.sessions['s1']).toBeUndefined();
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
      expect(registry.viewed).toBe(registry.sessions['s2']);
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
      expect(registry.sessions['s2'].needsAttention).toBe(true);
      registry.switchTo('s2');
      expect(registry.sessions['s2'].needsAttention).toBe(false);
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
      const session = registry.sessions['s1'];
      expect(session.status).toBe('working');
      expect(session.isStreaming).toBe(true);
    });

    it('agent_end event sets session status to idle and isStreaming to false', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      const session = registry.sessions['s1'];
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
    it('message_start creates streamingMessage with role and empty content', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      const session = registry.sessions['s1'];
      expect(session.streamingMessage).toEqual({ role: 'assistant', content: [] });
      expect(session.streamingKey).toMatch(/^msg-\d+$/);
    });

    it('message_update subtype start creates content block at contentIndex', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'text', text: '' },
        }),
      );
      const sm = registry.sessions['s1'].streamingMessage!;
      expect(sm.content[0]).toEqual({ type: 'text', text: '' });
    });

    it('message_update subtype delta appends text to existing block', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'text', text: '' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'delta',
          content: { type: 'text', text: 'Hello ' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'delta',
          content: { type: 'text', text: 'world' },
        }),
      );
      expect(registry.sessions['s1'].streamingMessage!.content[0].text).toBe('Hello world');
    });

    it('message_update subtype start for tool_call sets toolCallId and toolName', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'tool_call', text: '' },
          toolCallId: 'tc1',
          toolName: 'bash',
        }),
      );
      const block = registry.sessions['s1'].streamingMessage!.content[0];
      expect(block.type).toBe('tool_call');
      expect(block.toolCallId).toBe('tc1');
      expect(block.toolName).toBe('bash');
    });

    it('message_update with thinking content accumulates via delta', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'thinking', text: '' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'delta',
          content: { type: 'thinking', text: 'Let me ' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'delta',
          content: { type: 'thinking', text: 'think...' },
        }),
      );
      expect(registry.sessions['s1'].streamingMessage!.content[0].text).toBe('Let me think...');
    });

    it('message_end appends message, pushes streamingKey to messageKeys, and clears streaming state', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      const streamingKey = registry.sessions['s1'].streamingKey;
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'text', text: '' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'delta',
          content: { type: 'text', text: 'streaming...' },
        }),
      );
      const msg = makeAssistantMessage('Final answer');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg }));
      const session = registry.sessions['s1'];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(msg);
      expect(session.streamingMessage).toBeNull();
      expect(session.streamingKey).toBeNull();
      expect(session.messageKeys).toEqual([streamingKey]);
    });

    it('message_end increments messageCount', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg1 = makeAssistantMessage('First');
      const msg2 = makeAssistantMessage('Second');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg1 }));
      expect(registry.sessions['s1'].messageCount).toBe(1);
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg2 }));
      expect(registry.sessions['s1'].messageCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Tool Calls
  // --------------------------------------------------------------------------
  describe('Event Routing — Tool Calls', () => {
    it('tool_execution_start adds entry to toolExecutions', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc1',
          toolName: 'read',
          args: { path: '/foo' },
        }),
      );
      const execs = registry.sessions['s1'].toolExecutions;
      expect(execs['tc1']).toBeDefined();
      expect(execs['tc1'].name).toBe('read');
      expect(execs['tc1'].args).toEqual({ path: '/foo' });
      expect(execs['tc1'].partialResult).toBe('');
      expect(execs['tc1'].status).toBe('running');
    });

    it('tool_execution_update appends to partialResult', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc1',
          toolName: 'bash',
          args: {},
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_update', 's1', {
          toolCallId: 'tc1',
          content: 'partial ',
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_update', 's1', {
          toolCallId: 'tc1',
          content: 'result',
        }),
      );
      expect(registry.sessions['s1'].toolExecutions['tc1'].partialResult).toBe('partial result');
    });

    it('tool_execution_end marks entry as completed with result', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc1',
          toolName: 'bash',
          args: {},
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_end', 's1', {
          toolCallId: 'tc1',
          result: 'done',
        }),
      );
      const exec = registry.sessions['s1'].toolExecutions['tc1'];
      expect(exec).toBeDefined();
      expect(exec.status).toBe('completed');
      expect(exec.result).toBe('done');
    });

    it('toolResult message_end overwrites execution result with canonical data', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc1',
          toolName: 'read',
          args: { path: '/foo' },
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_end', 's1', {
          toolCallId: 'tc1',
          result: 'streaming result',
        }),
      );
      // toolResult message arrives with canonical result
      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: {
            role: 'toolResult',
            content: [{ type: 'tool_result', toolCallId: 'tc1', toolName: 'read', result: 'canonical result' }],
          },
        }),
      );
      const exec = registry.sessions['s1'].toolExecutions['tc1'];
      expect(exec.status).toBe('completed');
      expect(exec.result).toBe('canonical result');
    });

    it('rebuildToolExecutions populates from message history', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.messages = [
        { role: 'assistant', content: [{ type: 'tool_call', toolCallId: 'tc1', toolName: 'bash', args: {} }] },
        { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: 'tc1', toolName: 'bash', result: 'output' }] },
        { role: 'assistant', content: [{ type: 'tool_call', toolCallId: 'tc2', toolName: 'read', args: { path: '/x' } }] },
        { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: 'tc2', toolName: 'read', result: 'file content' }] },
      ];
      registry.rebuildToolExecutions(session);
      expect(session.toolExecutions['tc1']).toBeDefined();
      expect(session.toolExecutions['tc1'].status).toBe('completed');
      expect(session.toolExecutions['tc1'].result).toBe('output');
      expect(session.toolExecutions['tc2']).toBeDefined();
      expect(session.toolExecutions['tc2'].result).toBe('file content');
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Compaction
  // --------------------------------------------------------------------------
  describe('Event Routing — Compaction', () => {
    it('auto_compaction_start sets isCompacting to true', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('auto_compaction_start', 's1', { reason: 'threshold' }));
      expect(registry.sessions['s1'].isCompacting).toBe(true);
    });

    it('auto_compaction_end sets isCompacting to false', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('auto_compaction_start', 's1', { reason: 'threshold' }));
      registry.handleEvent(
        makeSessionEvent('auto_compaction_end', 's1', {
          result: {},
          aborted: false,
          willRetry: false,
        }),
      );
      expect(registry.sessions['s1'].isCompacting).toBe(false);
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
      const session = registry.sessions['s1'];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(msg);
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
    });

    it('full_resync replaces session state entirely', () => {
      registry.addSession('s1', '/path', 'proj');
      // Set some initial state
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      expect(registry.sessions['s1'].isStreaming).toBe(true);

      const messages: PimoteAgentMessage[] = [makeUserMessage('Hello'), makeAssistantMessage('Hi there')];
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
      const session = registry.sessions['s1'];
      expect(session.isStreaming).toBe(false);
      expect(session.status).toBe('idle');
      expect(session.model).toEqual({ provider: 'anthropic', id: 'claude-4', name: 'Claude 4' });
      expect(session.thinkingLevel).toBe('high');
      expect(session.autoCompactionEnabled).toBe(true);
      expect(session.messageCount).toBe(2);
      expect(session.messages).toEqual(messages);
    });
  });

  // --------------------------------------------------------------------------
  // Needs Attention
  // --------------------------------------------------------------------------
  describe('Needs Attention', () => {
    it('needsAttention starts as false for new sessions', () => {
      registry.addSession('s1', '/path', 'proj');
      expect(registry.sessions['s1'].needsAttention).toBe(false);
    });

    it('agent_end sets needsAttention=true when session is NOT the viewed session', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      expect(registry.sessions['s2'].needsAttention).toBe(true);
    });

    it('agent_end does NOT set needsAttention when session IS the viewed session', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      expect(registry.sessions['s1'].needsAttention).toBe(false);
    });

    it('switchTo() clears needsAttention', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      expect(registry.sessions['s2'].needsAttention).toBe(true);
      registry.switchTo('s2');
      expect(registry.sessions['s2'].needsAttention).toBe(false);
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
      expect(registry.sessions['s1'].firstMessage).toBe('What is the meaning of life?');
    });

    it('firstMessage is not overwritten by subsequent user messages', () => {
      registry.addSession('s1', '/path', 'proj');
      const msg1 = makeUserMessage('First question');
      const msg2 = makeUserMessage('Second question');
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg1 }));
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: msg2 }));
      expect(registry.sessions['s1'].firstMessage).toBe('First question');
    });
  });

  // --------------------------------------------------------------------------
  // Session Conflict
  // --------------------------------------------------------------------------
  describe('Session Conflict', () => {
    it('session_conflict event populates conflictingProcesses on the target session', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [
          { pid: 1234, command: 'node /usr/bin/pi' },
          { pid: 5678, command: 'node pi-coding-agent' },
        ],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingProcesses).toHaveLength(2);
      expect(session.conflictingProcesses[0].pid).toBe(1234);
      expect(session.conflictingProcesses[1].pid).toBe(5678);
    });

    it('session_conflict event for unknown sessionId is ignored', () => {
      expect(() =>
        registry.handleEvent({
          type: 'session_conflict',
          sessionId: 'unknown',
          processes: [{ pid: 99, command: 'pi' }],
        }),
      ).not.toThrow();
    });

    it('clearConflict() resets conflictingProcesses to empty', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [{ pid: 1234, command: 'pi' }],
      });
      expect(registry.sessions['s1'].conflictingProcesses).toHaveLength(1);
      registry.clearConflict('s1');
      expect(registry.sessions['s1'].conflictingProcesses).toEqual([]);
    });

    it('clearConflict() for unknown sessionId does not throw', () => {
      expect(() => registry.clearConflict('nonexistent')).not.toThrow();
    });

    it('subsequent session_conflict events replace previous conflicts', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [{ pid: 1111, command: 'pi' }],
      });
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [
          { pid: 2222, command: 'pi' },
          { pid: 3333, command: 'pi' },
        ],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingProcesses).toHaveLength(2);
      expect(session.conflictingProcesses[0].pid).toBe(2222);
    });
  });

  // --------------------------------------------------------------------------
  // Session Closed — Displacement / Kill Reasons
  // --------------------------------------------------------------------------
  describe('Session Closed — Displacement', () => {
    it('removeSession removes the session regardless of close reason (contract: reason is event-level, not class-level)', () => {
      registry.addSession('s1', '/path', 'proj');
      // The routing layer calls removeSession for all session_closed events,
      // whether reason is 'displaced', 'killed', or absent. The class itself
      // is reason-agnostic — it just removes the entry.
      registry.removeSession('s1');
      expect(registry.sessions['s1']).toBeUndefined();
    });

    it('displaced session that was viewed resets viewedSessionId', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      expect(registry.viewedSessionId).toBe('s1');
      // Simulate: routing layer receives session_closed with reason:'displaced' → calls removeSession
      registry.removeSession('s1');
      expect(registry.viewedSessionId).not.toBe('s1');
      // Should switch to a remaining session
      expect(registry.viewedSessionId).toBe('s2');
    });

    it('killed session removal switches to remaining session', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      // Simulate: routing layer receives session_closed with reason:'killed' → calls removeSession
      registry.removeSession('s1');
      expect(registry.sessions['s1']).toBeUndefined();
      expect(registry.viewedSessionId).toBe('s2');
    });

    it('removing the last session (any reason) sets viewedSessionId to null', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      registry.removeSession('s1');
      expect(registry.viewedSessionId).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Session Conflict — Remote Sessions
  // --------------------------------------------------------------------------
  describe('Session Conflict — Remote Sessions', () => {
    it('conflictingRemoteSessions initializes as empty array', () => {
      registry.addSession('s1', '/path', 'proj');
      expect(registry.sessions['s1'].conflictingRemoteSessions).toEqual([]);
    });

    it('session_conflict with remoteSessions populates conflictingRemoteSessions', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [],
        remoteSessions: [
          { sessionId: 'remote-1', status: 'working' },
          { sessionId: 'remote-2', status: 'idle' },
        ],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingRemoteSessions).toHaveLength(2);
      expect(session.conflictingRemoteSessions[0]).toEqual({ sessionId: 'remote-1', status: 'working' });
      expect(session.conflictingRemoteSessions[1]).toEqual({ sessionId: 'remote-2', status: 'idle' });
    });

    it('session_conflict with both processes and remoteSessions populates both fields', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [{ pid: 1234, command: 'node pi' }],
        remoteSessions: [{ sessionId: 'remote-1', status: 'idle' }],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingProcesses).toHaveLength(1);
      expect(session.conflictingProcesses[0].pid).toBe(1234);
      expect(session.conflictingRemoteSessions).toHaveLength(1);
      expect(session.conflictingRemoteSessions[0].sessionId).toBe('remote-1');
    });

    it('session_conflict with only processes (no remoteSessions) sets remoteSessions to empty', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [{ pid: 5678, command: 'pi' }],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingProcesses).toHaveLength(1);
      expect(session.conflictingRemoteSessions).toEqual([]);
    });

    it('subsequent session_conflict events replace previous remoteSessions', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [],
        remoteSessions: [{ sessionId: 'remote-1', status: 'working' }],
      });
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [],
        remoteSessions: [
          { sessionId: 'remote-2', status: 'idle' },
          { sessionId: 'remote-3', status: 'working' },
        ],
      });
      const session = registry.sessions['s1'];
      expect(session.conflictingRemoteSessions).toHaveLength(2);
      expect(session.conflictingRemoteSessions[0].sessionId).toBe('remote-2');
    });

    it('clearConflict() resets both conflictingProcesses and conflictingRemoteSessions', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent({
        type: 'session_conflict',
        sessionId: 's1',
        processes: [{ pid: 1234, command: 'pi' }],
        remoteSessions: [{ sessionId: 'remote-1', status: 'working' }],
      });
      expect(registry.sessions['s1'].conflictingProcesses).toHaveLength(1);
      expect(registry.sessions['s1'].conflictingRemoteSessions).toHaveLength(1);
      registry.clearConflict('s1');
      expect(registry.sessions['s1'].conflictingProcesses).toEqual([]);
      expect(registry.sessions['s1'].conflictingRemoteSessions).toEqual([]);
    });

    it('session_conflict for unknown sessionId with remoteSessions is ignored', () => {
      expect(() =>
        registry.handleEvent({
          type: 'session_conflict',
          sessionId: 'unknown',
          processes: [],
          remoteSessions: [{ sessionId: 'remote-1', status: 'idle' }],
        }),
      ).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Pending Steering Messages
  // --------------------------------------------------------------------------
  describe('Pending Steering Messages', () => {
    it('pendingSteeringMessages initializes as empty array', () => {
      registry.addSession('s1', '/path', 'proj');
      expect(registry.sessions['s1'].pendingSteeringMessages).toEqual([]);
    });

    it('optimistic add: pushing to pendingSteeringMessages tracks the message', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');
      expect(session.pendingSteeringMessages).toEqual(['fix the bug']);
    });

    it('reconciliation: message_end with role user removes the first matching pending message', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');
      session.pendingSteeringMessages.push('also update tests');

      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: makeUserMessage('fix the bug'),
        }),
      );

      expect(session.pendingSteeringMessages).toEqual(['also update tests']);
    });

    it('reconciliation: non-matching user message does not remove pending entries', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');

      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: makeUserMessage('something completely different'),
        }),
      );

      expect(session.pendingSteeringMessages).toEqual(['fix the bug']);
    });

    it('reconciliation: assistant message does not affect pending steering messages', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');

      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: makeAssistantMessage('I fixed the bug'),
        }),
      );

      expect(session.pendingSteeringMessages).toEqual(['fix the bug']);
    });

    it('reconciliation: only the first matching entry is removed when duplicates exist', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');
      session.pendingSteeringMessages.push('fix the bug');
      session.pendingSteeringMessages.push('update tests');

      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: makeUserMessage('fix the bug'),
        }),
      );

      expect(session.pendingSteeringMessages).toEqual(['fix the bug', 'update tests']);
    });

    it('reconciliation: empty pending list is unaffected by user message_end', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];

      registry.handleEvent(
        makeSessionEvent('message_end', 's1', {
          message: makeUserMessage('hello'),
        }),
      );

      expect(session.pendingSteeringMessages).toEqual([]);
    });

    it('full_resync does not affect pendingSteeringMessages (optimistic state preserved)', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('pending message');

      registry.handleEvent({
        type: 'full_resync',
        sessionId: 's1',
        state: {
          model: null,
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 's1',
          autoCompactionEnabled: false,
          messageCount: 0,
        },
        messages: [],
      });

      expect(session.pendingSteeringMessages).toEqual(['pending message']);
    });
  });

  describe('Session Replacement', () => {
    it('replaceSession re-keys the session entry with clean state', () => {
      registry.addSession('old-id', '/home/user/project', 'project');
      const old = registry.sessions['old-id']!;
      old.model = { provider: 'test', id: 'model-1', name: 'Test Model' };
      old.thinkingLevel = 'high';
      old.autoCompactionEnabled = true;
      old.gitBranch = 'main';
      old.messages = [makeUserMessage('hello'), makeAssistantMessage('hi')];
      old.messageKeys = ['msg-0', 'msg-1'];
      old.firstMessage = 'hello';
      old.messageCount = 2;
      old.status = 'working';

      registry.replaceSession('old-id', 'new-id', '/home/user/project', 'project');

      // Old entry should be gone
      expect(registry.sessions['old-id']).toBeUndefined();

      // New entry should exist with clean state
      const newSession = registry.sessions['new-id']!;
      expect(newSession).toBeDefined();
      expect(newSession.sessionId).toBe('new-id');
      expect(newSession.folderPath).toBe('/home/user/project');
      expect(newSession.projectName).toBe('project');
      // Clean state
      expect(newSession.messages).toEqual([]);
      expect(newSession.messageKeys).toEqual([]);
      expect(newSession.firstMessage).toBeUndefined();
      expect(newSession.messageCount).toBe(0);
      expect(newSession.status).toBe('idle');
      expect(newSession.toolExecutions).toEqual({});
      expect(newSession.streamingMessage).toBeNull();
      expect(newSession.draftText).toBe('');
      expect(newSession.pendingSteeringMessages).toEqual([]);
      // Preserved from old session
      expect(newSession.model).toEqual({ provider: 'test', id: 'model-1', name: 'Test Model' });
      expect(newSession.thinkingLevel).toBe('high');
      expect(newSession.autoCompactionEnabled).toBe(true);
      expect(newSession.gitBranch).toBe('main');
    });

    it('replaceSession updates viewedSessionId when old session was viewed', () => {
      registry.addSession('old-id', '/home/user/project', 'project');
      registry.switchTo('old-id');
      expect(registry.viewedSessionId).toBe('old-id');

      registry.replaceSession('old-id', 'new-id', '/home/user/project', 'project');

      expect(registry.viewedSessionId).toBe('new-id');
    });

    it('replaceSession does not change viewedSessionId when old session was not viewed', () => {
      registry.addSession('other', '/home/user/other', 'other');
      registry.addSession('old-id', '/home/user/project', 'project');
      registry.switchTo('other');

      registry.replaceSession('old-id', 'new-id', '/home/user/project', 'project');

      expect(registry.viewedSessionId).toBe('other');
    });

    it('replaceSession is a no-op for unknown old session ID', () => {
      registry.addSession('existing', '/home/user/project', 'project');
      registry.replaceSession('nonexistent', 'new-id', '/home/user/project', 'project');

      // Nothing changed
      expect(registry.sessions['existing']).toBeDefined();
      expect(registry.sessions['new-id']).toBeUndefined();
    });

    it('isActiveSession reflects the new ID after replacement', () => {
      registry.addSession('old-id', '/home/user/project', 'project');
      expect(registry.isActiveSession('old-id')).toBe(true);

      registry.replaceSession('old-id', 'new-id', '/home/user/project', 'project');

      expect(registry.isActiveSession('old-id')).toBe(false);
      expect(registry.isActiveSession('new-id')).toBe(true);
    });
  });
});
