import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PimoteEvent, PimoteAgentMessage, FolderInfo, PimoteResponse } from '@pimote/shared';
import { SessionRegistry, routeNotificationIntent, sessionRegistry, openExistingSession, openNewSession, newSessionInProject, closeSession } from './session-registry.svelte.js';
import { connection } from './connection.svelte.js';
import { commandStore } from './command-store.svelte.js';
import { editorTextRequest } from './input-bar.svelte.js';

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
      expect(session!.bashExecutions).toEqual({});
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
      // Simulate needsAttention being set (agent_settled on non-viewed session)
      registry.addSession('s2', '/path2', 'proj2');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      registry.handleEvent(makeSessionEvent('agent_settled', 's2'));
      expect(registry.sessions['s2'].needsAttention).toBe(true);
      registry.switchTo('s2');
      expect(registry.sessions['s2'].needsAttention).toBe(false);
    });

    it('agent_settled with aborted does not mark a background session as needing attention', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addSession('s2', '/path2', 'proj2');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      // The user aborted s2 themselves: the settle needs no attention flag.
      registry.handleEvent(makeSessionEvent('agent_settled', 's2', { aborted: true }));
      expect(registry.sessions['s2'].needsAttention).toBe(false);
      expect(registry.sessions['s2'].status).toBe('idle');
    });

    it('switchTo() with unknown sessionId sets viewedSessionId (no error)', () => {
      expect(() => registry.switchTo('unknown')).not.toThrow();
      expect(registry.viewedSessionId).toBe('unknown');
    });

    it('goHome() clears viewedSessionId so the dashboard renders', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      expect(registry.viewedSessionId).toBe('s1');

      registry.goHome();
      expect(registry.viewedSessionId).toBeNull();
      // The session itself stays open in the tray
      expect(registry.sessions['s1']).toBeDefined();
    });

    it('adoptHomeRoute() clears viewedSessionId after back-navigation to "/"', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      expect(registry.viewedSessionId).toBe('s1');

      const toViewed = vi.fn();
      registry.setViewNavigator({ toViewed });
      toViewed.mockClear();

      registry.adoptHomeRoute();
      expect(registry.viewedSessionId).toBeNull();
      // The URL already says "/" — adopting must not navigate again.
      expect(toViewed).not.toHaveBeenCalled();
      // The session itself stays open in the tray, as with goHome()
      expect(registry.sessions['s1']).toBeDefined();
    });

    it('adoptHomeRoute() when already home is a no-op', () => {
      const toViewed = vi.fn();
      registry.setViewNavigator({ toViewed });

      registry.adoptHomeRoute();
      expect(registry.viewedSessionId).toBeNull();
      expect(toViewed).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // View Navigation (registry→URL sync; see lib/nav.ts and session-route.ts)
  // --------------------------------------------------------------------------
  describe('View Navigation', () => {
    it('switchTo() marks the URL navigation in flight until the route observes it', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addSession('s2', '/path2', 'proj2');
      registry.setViewNavigator({ toViewed: vi.fn() });

      expect(registry.isViewNavigationPending()).toBe(false);
      registry.switchTo('s2');
      expect(registry.isViewNavigationPending()).toBe(true);

      registry.clearViewNavigation();
      expect(registry.isViewNavigationPending()).toBe(false);
    });

    it('replaceSession() of the viewed session marks the rekey navigation (New chip)', () => {
      registry.addSession('pending-uuid', '/path', 'proj');
      registry.setViewNavigator({ toViewed: vi.fn() });
      registry.switchTo('pending-uuid');
      registry.clearViewNavigation();

      registry.replaceSession('pending-uuid', 's-real', '/path', 'proj');
      expect(registry.viewedSessionId).toBe('s-real');
      expect(registry.isViewNavigationPending()).toBe(true);
    });

    it('removeSession() of the viewed session marks the remap navigation', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addSession('s2', '/path2', 'proj2');
      registry.setViewNavigator({ toViewed: vi.fn() });
      registry.switchTo('s1');
      registry.clearViewNavigation();

      registry.removeSession('s1');
      expect(registry.viewedSessionId).toBe('s2');
      expect(registry.isViewNavigationPending()).toBe(true);
    });

    it('goHome() marks a pending navigation to the dashboard (null target)', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.setViewNavigator({ toViewed: vi.fn() });
      registry.switchTo('s1');
      registry.clearViewNavigation();

      registry.goHome();
      expect(registry.viewedSessionId).toBeNull();
      expect(registry.isViewNavigationPending()).toBe(true);
    });

    it('adoptRouteView()/adoptHomeRoute() clear the marker — the URL took the lead', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addSession('s2', '/path2', 'proj2');
      registry.setViewNavigator({ toViewed: vi.fn() });
      registry.switchTo('s2');
      expect(registry.isViewNavigationPending()).toBe(true);

      registry.adoptRouteView('s1');
      expect(registry.isViewNavigationPending()).toBe(false);

      registry.switchTo('s2');
      registry.adoptHomeRoute();
      expect(registry.isViewNavigationPending()).toBe(false);
    });

    it('without a view navigator (SSR/tests) no navigation is ever claimed', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      expect(registry.isViewNavigationPending()).toBe(false);
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
  // Session Meta
  // --------------------------------------------------------------------------
  describe('Session Meta', () => {
    it('updateMeta() propagates git branch to sessions in the same folder only', () => {
      registry.addSession('s1', '/repo/app', 'app');
      registry.addSession('s2', '/repo/app', 'app');
      registry.addSession('s3', '/repo/other', 'other');

      registry.sessions['s2'].gitBranch = 'main';
      registry.sessions['s3'].gitBranch = 'release';

      registry.updateMeta('s1', {
        gitBranch: 'feature/live-branch',
        contextUsage: { percent: 12, contextWindow: 128000 },
        lifetimeCostUsd: 0,
      });

      expect(registry.sessions['s1'].gitBranch).toBe('feature/live-branch');
      expect(registry.sessions['s2'].gitBranch).toBe('feature/live-branch');
      expect(registry.sessions['s3'].gitBranch).toBe('release');
      expect(registry.sessions['s2'].contextUsage).toBeNull();
    });

    it('updateMeta() assigns lifetimeCostUsd to the target session only', () => {
      registry.addSession('s1', '/repo/app', 'app');
      registry.addSession('s2', '/repo/app', 'app');

      registry.updateMeta('s1', {
        gitBranch: null,
        contextUsage: null,
        lifetimeCostUsd: 1.23,
      });

      expect(registry.sessions['s1'].lifetimeCostUsd).toBe(1.23);
      // Cost is session-specific (like contextUsage), not folder-level like gitBranch.
      expect(registry.sessions['s2'].lifetimeCostUsd).toBe(0);
    });

    it('session state initializes lifetimeCostUsd to 0', () => {
      registry.addSession('s1', '/repo/app', 'app');
      expect(registry.sessions['s1'].lifetimeCostUsd).toBe(0);
    });

    it('session_state_changed applies git branch updates by folder', () => {
      registry.addSession('s1', '/repo/app', 'app');
      registry.addSession('s2', '/repo/app', 'app');
      registry.addSession('s3', '/repo/other', 'other');
      registry.sessions['s1'].gitBranch = 'main';
      registry.sessions['s2'].gitBranch = 'main';
      registry.sessions['s3'].gitBranch = 'release';

      registry.handleEvent({
        type: 'session_state_changed',
        sessionId: 's1',
        folderPath: '/repo/app',
        liveStatus: 'idle',
        connectedClientId: null,
        folderActiveSessionCount: 1,
        folderActiveStatus: 'idle',
        gitBranch: 'feature/worktree',
      });

      expect(registry.sessions['s1'].gitBranch).toBe('feature/worktree');
      expect(registry.sessions['s2'].gitBranch).toBe('feature/worktree');
      expect(registry.sessions['s3'].gitBranch).toBe('release');
    });

    it('session_state_changed updates and clears the active session name', () => {
      registry.addSession('s1', '/repo/app', 'app');
      registry.sessions['s1'].sessionName = 'Previous name';

      registry.handleEvent({
        type: 'session_state_changed',
        sessionId: 's1',
        folderPath: '/repo/app',
        liveStatus: 'working',
        connectedClientId: null,
        folderActiveSessionCount: 1,
        folderActiveStatus: 'working',
        sessionName: 'New name',
      });
      expect(registry.sessions['s1'].sessionName).toBe('New name');

      registry.handleEvent({
        type: 'session_state_changed',
        sessionId: 's1',
        folderPath: '/repo/app',
        liveStatus: 'working',
        connectedClientId: null,
        folderActiveSessionCount: 1,
        folderActiveStatus: 'working',
        sessionName: '',
      });
      expect(registry.sessions['s1'].sessionName).toBeNull();
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

    it('agent_settled drives the idle transition; agent_end alone stays working', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      // Terminal agent_end is a per-attempt content boundary, not the idle
      // boundary — a queued continuation or compaction may still follow, so the
      // session stays "working" until it genuinely settles.
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      expect(registry.sessions['s1'].status).toBe('working');
      expect(registry.sessions['s1'].isStreaming).toBe(true);
      // agent_settled is the authoritative idle boundary.
      registry.handleEvent(makeSessionEvent('agent_settled', 's1'));
      const session = registry.sessions['s1'];
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
    });

    it('agent_end clears an in-flight streamingMessage (e.g. abort during thinking)', () => {
      // Scenario: user aborts during a streaming thinking block. The SDK does not
      // emit message_end for the partial message — only agent_end. Without the
      // defensive clear, streamingMessage would linger and the UI would keep
      // treating the session as "streaming".
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
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
          content: { type: 'thinking', text: 'hmm…' },
        }),
      );
      expect(registry.sessions['s1'].streamingMessage).not.toBeNull();

      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      const session = registry.sessions['s1'];
      // Content cleanup runs on agent_end; the idle transition waits for
      // agent_settled, so isStreaming is still true here.
      expect(session.isStreaming).toBe(true);
      expect(session.streamingMessage).toBeNull();
      expect(session.streamingKey).toBeNull();
    });

    it('agent_end with willRetry stays working (retry is not a real end)', () => {
      // The SDK detected a retryable error and will re-run the prompt after
      // backoff (a fresh agent_start follows). The session must stay working
      // and keep its in-flight streaming message rather than flicker to idle.
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'text', text: '' },
        }),
      );
      registry.handleEvent(makeSessionEvent('agent_end', 's1', { willRetry: true }));
      const session = registry.sessions['s1'];
      expect(session.status).toBe('working');
      expect(session.isStreaming).toBe(true);
      expect(session.streamingMessage).not.toBeNull();
    });

    it('auto_retry_end with success:false ends streaming (user aborted during retry backoff)', () => {
      // When the user aborts during the retry-sleep backoff, the SDK cancels
      // the sleep and emits auto_retry_end{success:false}, but does NOT emit a
      // terminal agent_end (the prior agent_end already went out as
      // willRetry:true, which we intentionally ignore). Without handling this,
      // isStreaming stays true forever and the Abort button appears to do
      // nothing.
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      registry.handleEvent(
        makeSessionEvent('message_update', 's1', {
          contentIndex: 0,
          subtype: 'start',
          content: { type: 'text', text: '' },
        }),
      );
      registry.handleEvent(makeSessionEvent('agent_end', 's1', { willRetry: true }));
      expect(registry.sessions['s1'].isStreaming).toBe(true);

      registry.handleEvent(makeSessionEvent('auto_retry_end', 's1', { success: false, attempt: 1, finalError: 'Retry cancelled' }));
      const session = registry.sessions['s1'];
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
      expect(session.streamingMessage).toBeNull();
      expect(session.streamingKey).toBeNull();
    });

    it('auto_retry_end with success:true is a no-op (fresh agent_start follows)', () => {
      // When a retry attempt succeeds, the SDK emits auto_retry_end{success:true}
      // immediately followed by a fresh agent_start for the retried attempt.
      // We must NOT flip to idle here or the working state would flicker.
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1', { willRetry: true }));
      registry.handleEvent(makeSessionEvent('auto_retry_end', 's1', { success: true, attempt: 1 }));
      const session = registry.sessions['s1'];
      expect(session.status).toBe('working');
      expect(session.isStreaming).toBe(true);
    });

    it('events for unknown sessionId are ignored (no error)', () => {
      expect(() => registry.handleEvent(makeSessionEvent('agent_start', 'unknown'))).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Event Routing — Messages
  // --------------------------------------------------------------------------
  describe('Event Routing — Messages', () => {
    it('custom_entry appends a display-only custom message with a matching key', () => {
      registry.addSession('s1', '/path', 'proj');
      const message = {
        role: 'custom',
        content: [{ type: 'text', text: 'the prompt' }],
        customType: 'print-prompt',
        display: true,
        fromEntry: true,
        entryId: 'ce-1',
      };
      registry.handleEvent(makeSessionEvent('custom_entry', 's1', { message }));
      const session = registry.sessions['s1'];
      expect(session.messages).toEqual([message]);
      expect(session.messageKeys).toHaveLength(1);
      expect(session.messageKeys[0]).toMatch(/^msg-\d+$/);
      expect(session.messageCount).toBe(1);
      // Display-only: never touches streaming state
      expect(session.streamingMessage).toBeNull();
    });

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
      expect(sm.content[0]).toEqual({ type: 'text', text: '', streaming: true });
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

    it('tool_execution_end stores durationMs for the status display', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc3',
          toolName: 'bash',
          args: {},
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_end', 's1', {
          toolCallId: 'tc3',
          result: 'done',
          durationMs: 42,
        }),
      );
      expect(registry.sessions['s1'].toolExecutions['tc3'].durationMs).toBe(42);
    });

    it('tool_execution_end reduces the SDK AgentToolResult wrapper to text plus data', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.handleEvent(
        makeSessionEvent('tool_execution_start', 's1', {
          toolCallId: 'tc2',
          toolName: 'pimote_static_host',
          args: {},
        }),
      );
      registry.handleEvent(
        makeSessionEvent('tool_execution_end', 's1', {
          toolCallId: 'tc2',
          result: {
            content: [{ type: 'text', text: '{"slug":"demo"}' }],
            details: { slug: 'demo' },
            structuredContent: { slug: 'demo' },
          },
          isError: false,
        }),
      );
      const exec = registry.sessions['s1'].toolExecutions['tc2'];
      expect(exec.status).toBe('completed');
      expect(exec.result).toBe('{"slug":"demo"}');
      expect(exec.data).toEqual({ slug: 'demo' });
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
          { type: 'agent_settled', sessionId: 's1', cursor: 4 },
        ],
      });
      const session = registry.sessions['s1'];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(msg);
      expect(session.status).toBe('idle');
      expect(session.isStreaming).toBe(false);
    });

    it('full_resync replaces canonical session state, preserves client metadata, and resets transient runtime fields', () => {
      registry.addSession('s1', '/path', 'proj');
      const before = registry.sessions['s1'];
      before.draftText = 'keep my unsent text';
      before.needsAttention = true;
      before.restoreMode = 'full_resync_cursor_stale';
      before.isRestoring = true;
      before.contextUsage = { percent: 42, contextWindow: 128000 };
      before.lifetimeCostUsd = 12.34;
      before.usageBreakdown = {
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      };
      before.gitBranch = 'feature/resync';
      const folderRow: FolderInfo = {
        path: '/path',
        name: 'proj',
        nature: 'persona',
        shortcutCount: 2,
        favorite: false,
        archived: false,
        tags: [],
        missing: false,
        activeSessionCount: 0,
        externalProcessCount: 0,
      };
      before.folder = folderRow;
      before.pendingSteeringMessages.push('pending');
      before.conflictingProcesses = [{ pid: 1234, command: 'pi' }];
      before.bashExecutions = {
        'bash-in-flight': {
          id: 'bash-in-flight',
          command: 'sleep 30',
          excludeFromContext: true,
          output: 'starting…',
          status: 'running',
        },
      };
      before.lastBotActivityTimestamp = '2026-04-04T12:00:00.000Z';
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
      expect(session.firstMessage).toBe('Hello');
      expect(session.draftText).toBe('keep my unsent text');
      expect(session.restoreMode).toBe('full_resync_cursor_stale');
      expect(session.isRestoring).toBe(true);
      expect(session.contextUsage).toEqual({ percent: 42, contextWindow: 128000 });
      expect(session.lifetimeCostUsd).toBe(12.34);
      expect(session.usageBreakdown).toEqual({
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      });
      expect(session.gitBranch).toBe('feature/resync');
      // The folder pointer is client-owned linkage — the server-authoritative
      // rebuild must carry it, same class as the draft.
      expect(session.folder).toBe(folderRow);
      expect(session.needsAttention).toBe(false);
      expect(session.pendingSteeringMessages).toEqual(['pending']);
      before.pendingSteeringMessages.push('stale mutation');
      expect(session.pendingSteeringMessages).toEqual(['pending']);
      expect(session.conflictingProcesses).toEqual([]);
      expect(session.bashExecutions).toEqual({});
      expect(session.lastBotActivityTimestamp).toBeNull();
    });

    it('full_resync clears widgetCards like panelCards (no ghost carry-over)', () => {
      registry.addSession('s1', '/path', 'proj');
      const before = registry.sessions['s1'];
      before.panelCards = [{ id: 'subagents:test-review', header: { title: 'test-review' } }];
      before.widgetCards = { 'widget:status': { id: 'widget:status', header: { title: 'Status' }, body: [] } };

      registry.handleEvent({
        type: 'full_resync',
        sessionId: 's1',
        state: {
          model: null,
          thinkingLevel: 'default',
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
        },
        messages: [],
      });

      const session = registry.sessions['s1'];
      expect(session.panelCards).toEqual([]);
      expect(session.widgetCards).toEqual({});
    });

    it('full_resync preserves cleared metadata and a queue snapshot, then later snapshots replace them', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.updateMeta('s1', { gitBranch: null, contextUsage: null, lifetimeCostUsd: 0 });
      registry.sessions.s1.pendingSteeringMessages = ['queued before reconnect'];

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

      let session = registry.sessions.s1;
      expect(session.contextUsage).toBeNull();
      expect(session.lifetimeCostUsd).toBe(0);
      expect(session.gitBranch).toBeNull();
      expect(session).not.toHaveProperty('usageBreakdown');
      expect(session.pendingSteeringMessages).toEqual(['queued before reconnect']);

      const breakdown = {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      };
      registry.updateMeta('s1', {
        gitBranch: 'feature/reconnected',
        contextUsage: { percent: 18, contextWindow: 64000 },
        lifetimeCostUsd: 8.5,
        usageBreakdown: breakdown,
      });
      registry.handleEvent(makeSessionEvent('queue_update', 's1', { steering: ['authoritative queue'], followUp: [] }));

      session = registry.sessions.s1;
      expect(session.gitBranch).toBe('feature/reconnected');
      expect(session.contextUsage).toEqual({ percent: 18, contextWindow: 64000 });
      expect(session.lifetimeCostUsd).toBe(8.5);
      expect(session.usageBreakdown).toEqual(breakdown);
      expect(session.pendingSteeringMessages).toEqual(['authoritative queue']);

      registry.updateMeta('s1', { gitBranch: null, contextUsage: null, lifetimeCostUsd: 0 });
      registry.handleEvent(makeSessionEvent('queue_update', 's1', { steering: [], followUp: ['follow-up'] }));
      session = registry.sessions.s1;
      expect(session.gitBranch).toBeNull();
      expect(session.contextUsage).toBeNull();
      expect(session.lifetimeCostUsd).toBe(0);
      expect(session).not.toHaveProperty('usageBreakdown');
      expect(session.pendingSteeringMessages).toEqual([]);
    });

    it('full_resync during restore keeps the same session identity and viewed navigation', () => {
      registry.addSession('s1', '/path', 'proj');
      const toViewed = vi.fn();
      registry.setViewNavigator({ toViewed });
      registry.switchTo('s1');
      registry.clearViewNavigation();
      registry.handleEvent(makeSessionEvent('session_restore', 's1', { mode: 'full_resync_cursor_stale', status: 'started' }));

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

      expect(registry.viewedSessionId).toBe('s1');
      expect(registry.sessions.s1.sessionId).toBe('s1');
      expect(registry.sessions.s1.restoreMode).toBe('full_resync_cursor_stale');
      expect(registry.sessions.s1.isRestoring).toBe(true);
      expect(toViewed).toHaveBeenCalledTimes(1);
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

    it('agent_settled sets needsAttention=true when session is NOT the viewed session', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      registry.handleEvent(makeSessionEvent('agent_settled', 's2'));
      expect(registry.sessions['s2'].needsAttention).toBe(true);
    });

    it('agent_end with willRetry does NOT set needsAttention on a non-viewed session', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2', { willRetry: true }));
      expect(registry.sessions['s2'].needsAttention).toBe(false);
    });

    it('agent_settled does NOT set needsAttention when session IS the viewed session', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's1'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1'));
      registry.handleEvent(makeSessionEvent('agent_settled', 's1'));
      expect(registry.sessions['s1'].needsAttention).toBe(false);
    });

    it('switchTo() clears needsAttention', () => {
      registry.addSession('s1', '/path/a', 'a');
      registry.addSession('s2', '/path/b', 'b');
      registry.switchTo('s1');
      registry.handleEvent(makeSessionEvent('agent_start', 's2'));
      registry.handleEvent(makeSessionEvent('agent_end', 's2'));
      registry.handleEvent(makeSessionEvent('agent_settled', 's2'));
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
  // Pending Steering Messages
  // --------------------------------------------------------------------------
  describe('Pending Steering Messages', () => {
    it('pendingSteeringMessages initializes as empty array', () => {
      registry.addSession('s1', '/path', 'proj');
      expect(registry.sessions['s1'].pendingSteeringMessages).toEqual([]);
    });

    it('setDraftText persists and signals text for an unmounted background session', () => {
      registry.addSession('s1', '/path/one', 'one');
      registry.addSession('s2', '/path/two', 'two');
      registry.switchTo('s1');
      const beforeSeq = editorTextRequest.seq;

      registry.setDraftText('s2', 'background text');

      expect(registry.sessions.s2.draftText).toBe('background text');
      expect(registry.sessions.s1.draftText).toBe('');
      expect(editorTextRequest).toMatchObject({ sessionId: 's2', text: 'background text', seq: beforeSeq + 1 });
      editorTextRequest.sessionId = '';
      editorTextRequest.text = '';
      editorTextRequest.seq = 0;
    });

    it('queue_update replaces optimistic pending messages with the authoritative steering snapshot', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.pendingSteeringMessages = ['stale optimistic message'];
      const steering = ['first pending', 'second pending'];

      registry.handleEvent(makeSessionEvent('queue_update', 's1', { steering, followUp: ['follow-up only'] }));

      expect(session.pendingSteeringMessages).toEqual(steering);
      steering.push('mutated event payload');
      expect(session.pendingSteeringMessages).toEqual(['first pending', 'second pending']);
    });

    it('queue_update clears pending steering without changing the draft or lifecycle', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.pendingSteeringMessages = ['queued'];
      session.draftText = 'keep draft';
      session.isStreaming = true;
      session.status = 'working';

      registry.handleEvent(makeSessionEvent('queue_update', 's1', { steering: [], followUp: [] }));

      expect(session.pendingSteeringMessages).toEqual([]);
      expect(session.draftText).toBe('keep draft');
      expect(session.isStreaming).toBe(true);
      expect(session.status).toBe('working');
    });

    it("queued_drafts_restored prepends this client's messages to its draft", () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.draftText = 'keep draft';

      registry.handleEvent(makeSessionEvent('queued_drafts_restored', 's1', { steering: ['queued a'], followUp: ['later'] }));

      expect(session.draftText).toBe('queued a\nlater\nkeep draft');
    });

    it('queued_drafts_restored with no messages leaves the draft unchanged', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.draftText = 'keep draft';

      registry.handleEvent(makeSessionEvent('queued_drafts_restored', 's1', { steering: [], followUp: [] }));

      expect(session.draftText).toBe('keep draft');
    });

    it('queued_drafts_restored adds one joining newline before the latest draft', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.draftText = 'latest draft';

      registry.handleEvent(makeSessionEvent('queued_drafts_restored', 's1', { steering: ['recovered'], followUp: [] }));

      expect(session.draftText).toBe('recovered\nlatest draft');
    });

    it('consumed message_end does not remove an identical message left in the authoritative queue', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions.s1;
      session.pendingSteeringMessages = ['same text', 'same text'];
      // The SDK emits the remaining queue before starting the consumed user message.
      registry.handleEvent(makeSessionEvent('queue_update', 's1', { steering: ['same text'], followUp: [] }));

      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'user' }));
      registry.handleEvent(makeSessionEvent('message_end', 's1', { message: makeUserMessage('same text') }));

      expect(session.pendingSteeringMessages).toEqual(['same text']);
    });

    it('optimistic add: pushing to pendingSteeringMessages tracks the message', () => {
      registry.addSession('s1', '/path', 'proj');
      const session = registry.sessions['s1'];
      session.pendingSteeringMessages.push('fix the bug');
      expect(session.pendingSteeringMessages).toEqual(['fix the bug']);
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

    it('full_resync carries the latest pendingSteeringMessages snapshot', () => {
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

      expect(registry.sessions['s1'].pendingSteeringMessages).toEqual(['pending message']);
    });
  });

  // --------------------------------------------------------------------------
  // Optimistic user message convergence (multi-observer)
  //
  // The composer appends the sent text before the server round-trip
  // (addOptimisticUserMessage) under a clientMessageId. The server stamps a
  // started prompt's user echo with that id; the composer drops the entry
  // when the prompt will not echo it. These tests pin whether each client
  // converges to the server-authoritative transcript order.
  // --------------------------------------------------------------------------
  describe('Optimistic user message convergence (multi-observer)', () => {
    function textsOf(sessionId: string): string[] {
      const session = registry.sessions[sessionId]!;
      return session.messages.map((m) => m.content.find((c: any) => c.type === 'text')?.text ?? '');
    }

    function userEcho(sessionId: string, text: string, clientMessageId?: string): PimoteEvent[] {
      const stamp = clientMessageId !== undefined ? { clientMessageId } : {};
      return [makeSessionEvent('message_start', sessionId, { role: 'user', ...stamp }), makeSessionEvent('message_end', sessionId, { message: makeUserMessage(text), ...stamp })];
    }

    function replayUserMessage(sessionId: string, text: string, clientMessageId?: string): void {
      for (const event of userEcho(sessionId, text, clientMessageId)) registry.handleEvent(event);
    }

    function replayAssistantMessage(sessionId: string, text: string): void {
      registry.handleEvent(makeSessionEvent('message_start', sessionId, { role: 'assistant' }));
      registry.handleEvent(makeSessionEvent('message_end', sessionId, { message: makeAssistantMessage(text) }));
    }

    it('single sender: the stamped echo replaces the optimistic entry exactly once', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'my message', 'c1');

      replayUserMessage('s1', 'my message', 'c1');

      expect(textsOf('s1')).toEqual(['my message']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
      expect(registry.sessions['s1'].streamingMessage).toBeNull();
    });

    it('the stamped echo replaces its entry even when pi rewrote the text', () => {
      // Input handlers and template expansion can change the text pi records.
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'typed text', 'c1');

      replayUserMessage('s1', 'typed text, rewritten by an input handler', 'c1');

      expect(textsOf('s1')).toEqual(['typed text, rewritten by an input handler']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('two senders: the other client\u2019s echo inserts ahead of the pending entry, own echo replaces it \u2014 server order preserved', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'message from B', 'b1');

      // Wire order for B: A\u2019s user message (stamped with A\u2019s id), then B\u2019s.
      replayUserMessage('s1', 'message from A', 'a1');
      expect(textsOf('s1')).toEqual(['message from A', 'message from B']);
      expect(registry.sessions['s1'].optimisticEntries).toHaveLength(1);

      replayUserMessage('s1', 'message from B', 'b1');
      expect(textsOf('s1')).toEqual(['message from A', 'message from B']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('a foreign echo with the same text does not consume the own entry', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'same words', 'mine');

      replayUserMessage('s1', 'same words', 'theirs');

      expect(textsOf('s1')).toEqual(['same words', 'same words']);
      expect(registry.sessions['s1'].optimisticEntries).toHaveLength(1);
    });

    it('reconnect replay: buffered_events replaces the pending optimistic entry once', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'sent right before the drop', 'c1');

      registry.handleEvent({
        type: 'buffered_events',
        sessionId: 's1',
        events: userEcho('s1', 'sent right before the drop', 'c1') as any,
      });

      expect(textsOf('s1')).toEqual(['sent right before the drop']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('full resync replaces the whole transcript: an unreconciled optimistic entry is dropped, not duplicated', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'dropped by the server race', 'c1');

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
        messages: [makeUserMessage('real message')],
      });

      expect(textsOf('s1')).toEqual(['real message']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('a dropped entry (prompt queued) leaves no stale copy; its later unstamped echo appends once', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'steered', 'c1');
      registry.dropOptimisticUserMessage('s1', 'c1');
      expect(textsOf('s1')).toEqual([]);

      replayAssistantMessage('s1', 'the reply');
      replayUserMessage('s1', 'steered');

      expect(textsOf('s1')).toEqual(['the reply', 'steered']);
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('a prompt that never echoes does not pin later messages above the bottom', () => {
      // Regression: a never-echoed entry used to stay at the front of the
      // queue, so every later turn inserted above it and the newest turn
      // appeared to vanish on each message_end.
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'consumed by an input handler', 'c1');
      registry.dropOptimisticUserMessage('s1', 'c1');
      registry.addOptimisticUserMessage('s1', 'run the bench', 'c2');
      replayUserMessage('s1', 'run the bench', 'c2');

      for (const turn of ['turn 1', 'turn 2', 'turn 3']) replayAssistantMessage('s1', turn);

      expect(textsOf('s1')).toEqual(['run the bench', 'turn 1', 'turn 2', 'turn 3']);
    });

    it('assistant echo orders ahead of a still-pending optimistic entry', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'pending', 'c1');

      replayAssistantMessage('s1', 'the reply');

      expect(textsOf('s1')).toEqual(['the reply', 'pending']);
      expect(registry.sessions['s1'].optimisticEntries).toHaveLength(1);
    });

    it('the own echo does not kill an in-flight assistant streaming placeholder', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'mine', 'c1');

      registry.handleEvent(makeSessionEvent('message_start', 's1', { role: 'assistant' }));
      expect(registry.sessions['s1'].streamingMessage?.role).toBe('assistant');

      replayUserMessage('s1', 'mine', 'c1');

      expect(registry.sessions['s1'].streamingMessage?.role).toBe('assistant');
      expect(registry.sessions['s1'].optimisticEntries).toEqual([]);
    });

    it('queued_drafts_restored restores the composer and leaves the transcript alone', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.addOptimisticUserMessage('s1', 'started prompt', 'c1');

      registry.handleEvent(makeSessionEvent('queued_drafts_restored', 's1', { steering: ['queued but aborted'], followUp: [] }));

      expect(textsOf('s1')).toEqual(['started prompt']);
      expect(registry.sessions['s1'].optimisticEntries).toHaveLength(1);
      expect(registry.sessions['s1'].draftText).toBe('queued but aborted');
    });
  });

  describe('Fork entry ids', () => {
    function streamMessage(sessionId: string, message: PimoteAgentMessage): void {
      registry.handleEvent(makeSessionEvent('message_start', sessionId, { role: message.role }));
      registry.handleEvent(makeSessionEvent('message_end', sessionId, { message }));
    }

    it('assigns ids to streamed messages from the tail, even when compaction shortened the server view', () => {
      registry.addSession('s1', '/path', 'proj');
      streamMessage('s1', makeUserMessage('old question'));
      streamMessage('s1', makeAssistantMessage('old answer'));
      registry.handleEvent(makeSessionEvent('agent_end', 's1', { messageEntryIds: ['e-old-q', 'e-old-a'] }));
      // Compaction replaces the old messages with a summary in the server's
      // context view; the client keeps its full history.
      streamMessage('s1', makeUserMessage('new question'));
      streamMessage('s1', makeAssistantMessage('new answer'));
      // Pending prompt sent after the run: never persisted yet.
      registry.addOptimisticUserMessage('s1', 'pending', 'c1');

      registry.handleEvent(makeSessionEvent('agent_end', 's1', { messageEntryIds: ['summary', 'e-new-q', 'e-new-a'] }));

      expect(registry.sessions['s1']!.messages.map((m) => m.entryId)).toEqual(['e-old-q', 'e-old-a', 'e-new-q', 'e-new-a', undefined]);
    });

    it('stops at a message whose id disagrees instead of shifting ids onto the wrong messages', () => {
      registry.addSession('s1', '/path', 'proj');
      streamMessage('s1', makeUserMessage('q'));
      registry.sessions['s1']!.messages[0].entryId = 'e-unexpected';
      streamMessage('s1', makeAssistantMessage('a'));

      registry.handleEvent(makeSessionEvent('agent_end', 's1', { messageEntryIds: ['e-q', 'e-a'] }));

      expect(registry.sessions['s1']!.messages.map((m) => m.entryId)).toEqual(['e-unexpected', 'e-a']);
    });
  });

  describe('Mid-run full resync', () => {
    function resync(extra: Record<string, unknown>): void {
      registry.handleEvent({
        type: 'full_resync',
        sessionId: 's1',
        state: {
          model: null,
          thinkingLevel: 'off',
          isStreaming: true,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 's1',
          autoCompactionEnabled: false,
          messageCount: 1,
        },
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_call', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } }],
          },
        ],
        ...extra,
      } as any);
    }

    it('keeps the in-flight message live: later deltas extend its last block', () => {
      registry.addSession('s1', '/path', 'proj');
      resync({ streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'half a ' }] } });

      registry.handleEvent(makeSessionEvent('message_update', 's1', { subtype: 'delta', contentIndex: 0, content: { type: 'text', text: 'sentence' } }));

      const session = registry.sessions['s1']!;
      expect(session.streamingKey).not.toBeNull();
      expect(session.streamingMessage?.content).toEqual([{ type: 'text', text: 'half a sentence', streaming: true }]);
    });

    it('tracks tool calls still running, so their output and result apply', () => {
      registry.addSession('s1', '/path', 'proj');
      resync({ runningToolCallIds: ['tc-1'] });

      registry.handleEvent(makeSessionEvent('tool_execution_update', 's1', { toolCallId: 'tc-1', content: 'file.txt\n' }));

      expect(registry.sessions['s1']!.toolExecutions['tc-1']).toMatchObject({ name: 'bash', args: { command: 'ls' }, status: 'running', partialResult: 'file.txt\n' });
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
      old.contextUsage = { percent: 77, contextWindow: 64000 };
      old.lifetimeCostUsd = 9.87;
      old.usageBreakdown = {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      };
      old.pendingSteeringMessages = ['must not revive'];
      old.messages = [makeUserMessage('hello'), makeAssistantMessage('hi')];
      old.messageKeys = ['msg-0', 'msg-1'];
      old.firstMessage = 'hello';
      old.messageCount = 2;
      old.status = 'working';
      old.downloads = [{ id: 'old-download', filename: 'old.txt', sizeBytes: 1, href: '/d/old-download' }];

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
      expect(newSession.contextUsage).toBeNull();
      expect(newSession.lifetimeCostUsd).toBe(0);
      expect(newSession).not.toHaveProperty('usageBreakdown');
      expect(newSession.downloads).toEqual([]);
      // Preserved from old session
      expect(newSession.model).toEqual({ provider: 'test', id: 'model-1', name: 'Test Model' });
      expect(newSession.thinkingLevel).toBe('high');
      expect(newSession.autoCompactionEnabled).toBe(true);
      expect(newSession.gitBranch).toBe('main');
    });

    it('replacement followed by resync keeps new usage and queue clean and ignores removed-id events', () => {
      registry.addSession('old-id', '/home/user/project', 'project');
      const old = registry.sessions['old-id'];
      old.contextUsage = { percent: 91, contextWindow: 32000 };
      old.lifetimeCostUsd = 4.56;
      old.usageBreakdown = {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      };
      old.pendingSteeringMessages = ['removed queue'];
      old.gitBranch = 'preserve branch';

      registry.replaceSession('old-id', 'new-id', '/home/user/project', 'project');
      registry.handleEvent({
        type: 'full_resync',
        sessionId: 'new-id',
        state: {
          model: null,
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          sessionFile: undefined,
          sessionId: 'new-id',
          autoCompactionEnabled: false,
          messageCount: 0,
        },
        messages: [],
      });

      expect(registry.sessions['new-id'].contextUsage).toBeNull();
      expect(registry.sessions['new-id'].lifetimeCostUsd).toBe(0);
      expect(registry.sessions['new-id']).not.toHaveProperty('usageBreakdown');
      expect(registry.sessions['new-id'].pendingSteeringMessages).toEqual([]);
      expect(registry.sessions['new-id'].gitBranch).toBe('preserve branch');

      registry.handleEvent(makeSessionEvent('queue_update', 'old-id', { steering: ['stale'], followUp: [] }));
      registry.handleEvent(makeSessionEvent('full_resync', 'old-id', { messages: [] }));
      registry.updateMeta('old-id', { gitBranch: 'stale', contextUsage: { percent: 1, contextWindow: 1 }, lifetimeCostUsd: 1 });
      expect(registry.sessions['old-id']).toBeUndefined();
      expect(registry.sessions['new-id'].pendingSteeringMessages).toEqual([]);
      expect(registry.sessions['new-id'].lifetimeCostUsd).toBe(0);
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

  // --------------------------------------------------------------------------
  // File downloads
  // --------------------------------------------------------------------------
  describe('File downloads', () => {
    const offered = {
      id: 'opaque-1',
      filename: 'report.pdf',
      sizeBytes: 42,
      href: '/d/opaque-1',
    };

    it('reduces an offered download update to the owning session snapshot', () => {
      registry.addSession('s1', '/workspace/project', 'project');
      registry.handleEvent({ type: 'download_update', sessionId: 's1', cause: 'offered', offeredDownloadId: offered.id, downloads: [offered] });
      expect(registry.sessions['s1'].downloads).toEqual([offered]);
    });

    it('replaces the full snapshot for restored, consumed, and revoked causes', () => {
      registry.addSession('s1', '/workspace/project', 'project');
      registry.handleEvent({ type: 'download_update', sessionId: 's1', cause: 'restored', downloads: [offered] });
      registry.handleEvent({ type: 'download_update', sessionId: 's1', cause: 'consumed', downloads: [] });
      expect(registry.sessions['s1'].downloads).toEqual([]);
      registry.handleEvent({ type: 'download_update', sessionId: 's1', cause: 'revoked', downloads: [offered] });
      expect(registry.sessions['s1'].downloads).toEqual([offered]);
    });

    it('keeps download snapshots isolated between sessions', () => {
      registry.addSession('s1', '/workspace/one', 'one');
      registry.addSession('s2', '/workspace/two', 'two');
      registry.handleEvent({ type: 'download_update', sessionId: 's1', cause: 'offered', offeredDownloadId: offered.id, downloads: [offered] });
      expect(registry.sessions['s2'].downloads).toEqual([]);
    });

    it('forwards the typed update to the presentation coordinator after reducing its owning snapshot', () => {
      const onDownloadUpdate = vi.fn(() => {
        expect(registry.sessions['s1'].downloads).toEqual([offered]);
      });
      registry = new SessionRegistry(onDownloadUpdate);
      registry.addSession('s1', '/workspace/project', 'project');
      const update = { type: 'download_update' as const, sessionId: 's1', cause: 'offered' as const, offeredDownloadId: offered.id, downloads: [offered] };

      registry.handleEvent(update);

      expect(onDownloadUpdate).toHaveBeenCalledTimes(1);
      expect(onDownloadUpdate).toHaveBeenCalledWith(update);
    });
  });

  // --------------------------------------------------------------------------
  // Native bash executions
  // --------------------------------------------------------------------------
  describe('Native bash executions', () => {
    it('starts a transient execution with running state and caller correlation ID', () => {
      registry.addSession('s1', '/path', 'proj');

      registry.startBash('s1', {
        id: 'bash-1',
        command: 'printf hello',
        excludeFromContext: false,
      });

      expect(registry.sessions['s1'].bashExecutions).toEqual({
        'bash-1': {
          id: 'bash-1',
          command: 'printf hello',
          excludeFromContext: false,
          output: '',
          status: 'running',
        },
      });
    });

    it('appends identified output deltas to the matching execution', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.startBash('s1', { id: 'bash-1', command: 'printf hello', excludeFromContext: false });
      registry.updateBash('s1', { id: 'bash-1', delta: 'hello' });
      registry.updateBash('s1', { id: 'bash-1', delta: '\\n' });

      expect(registry.sessions['s1'].bashExecutions['bash-1'].output).toBe('hello\\n');
    });

    it('applies an id-less update to the sole running bash and drops ambiguous updates', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.startBash('s1', { id: 'bash-1', command: 'one', excludeFromContext: false });
      registry.updateBash('s1', { delta: 'one output' });
      expect(registry.sessions['s1'].bashExecutions['bash-1'].output).toBe('one output');

      registry.startBash('s1', { id: 'bash-2', command: 'two', excludeFromContext: true });
      expect(() => registry.updateBash('s1', { delta: 'ambiguous' })).not.toThrow();
      expect(() => registry.updateBash('s1', { id: 'unknown', delta: 'unmatched' })).not.toThrow();
      expect(registry.sessions['s1'].bashExecutions['bash-1'].output).toBe('one output');
      expect(registry.sessions['s1'].bashExecutions['bash-2'].output).toBe('');
    });

    it('finalizes an execution with the native result and moves it to a bashExecution message', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.startBash('s1', { id: 'bash-1', command: 'false', excludeFromContext: true });
      registry.updateBash('s1', { id: 'bash-1', delta: 'failed\\n' });
      registry.completeBash('s1', 'bash-1', {
        output: 'failed\\n',
        exitCode: 1,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/bash-output.log',
      });

      expect(registry.sessions['s1'].bashExecutions['bash-1']).toBeUndefined();
      expect(registry.sessions['s1'].messages).toContainEqual(
        expect.objectContaining({
          role: 'bashExecution',
          command: 'false',
          output: 'failed\\n',
          exitCode: 1,
          cancelled: false,
          truncated: true,
          fullOutputPath: '/tmp/bash-output.log',
          excludeFromContext: true,
        }),
      );
      expect(registry.sessions['s1'].messageKeys).toHaveLength(registry.sessions['s1'].messages.length);

      // The response is canonical; a duplicated update that arrives afterward
      // must not resurrect transient state or append output twice.
      registry.updateBash('s1', { id: 'bash-1', delta: 'late duplicate' });
      expect(registry.sessions['s1'].bashExecutions['bash-1']).toBeUndefined();
      expect(registry.sessions['s1'].messages[0]).toMatchObject({ output: 'failed\\n' });
    });

    it('promotes a cancelled native result without converting it into a generic error', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.startBash('s1', { id: 'bash-1', command: 'sleep 30', excludeFromContext: false });

      registry.completeBash('s1', 'bash-1', {
        output: 'stopped',
        cancelled: true,
        truncated: false,
      });

      expect(registry.sessions['s1'].messages).toContainEqual(
        expect.objectContaining({
          role: 'bashExecution',
          command: 'sleep 30',
          output: 'stopped',
          cancelled: true,
          truncated: false,
        }),
      );
      expect(registry.sessions['s1'].bashExecutions['bash-1']).toBeUndefined();
    });

    it('retains a dispatch failure as an error-state transient without adding context', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.startBash('s1', { id: 'bash-1', command: 'pwd', excludeFromContext: false });

      registry.failBash('s1', 'bash-1', 'WebSocket closed');
      registry.updateBash('s1', { id: 'bash-1', delta: 'late output' });

      expect(registry.sessions['s1'].bashExecutions['bash-1']).toMatchObject({
        id: 'bash-1',
        command: 'pwd',
        status: 'error',
        error: 'WebSocket closed',
        output: '',
      });
      expect(registry.sessions['s1'].messages).toEqual([]);
    });

    it('clears all transient executions without changing persisted messages', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.sessions['s1'].messages = [{ role: 'user', content: [{ type: 'text', text: 'keep' }] }];
      registry.sessions['s1'].bashExecutions = {
        'bash-1': {
          id: 'bash-1',
          command: 'sleep 1',
          excludeFromContext: false,
          output: '',
          status: 'running',
        },
      };

      registry.clearBash('s1');

      expect(registry.sessions['s1'].bashExecutions).toEqual({});
      expect(registry.sessions['s1'].messages).toHaveLength(1);
    });

    it('reduces a live bash update event through the public event boundary', () => {
      registry.addSession('s1', '/path', 'proj');
      registry.sessions['s1'].bashExecutions = {
        'bash-1': {
          id: 'bash-1',
          command: 'printf hello',
          excludeFromContext: false,
          output: '',
          status: 'running',
        },
      };

      registry.handleEvent({ type: 'bash_execution_update', sessionId: 's1', id: 'bash-1', delta: 'hello' });

      expect(registry.sessions['s1'].bashExecutions['bash-1'].output).toBe('hello');
    });
  });
});

describe('reconnect restore cleanup', () => {
  afterEach(() => {
    sessionRegistry.removeSession('restore-failed');
    sessionRegistry.removeSession('restore-retained');
    connection.removeSubscribedSession('restore-failed');
    connection.removeSubscribedSession('restore-retained');
  });

  it('removes only the failed session locally after a non-definitive restore failure', () => {
    sessionRegistry.addSession('restore-failed', '/repos/failing', 'failing');
    sessionRegistry.addSession('restore-retained', '/repos/retained', 'retained');
    connection.addSubscribedSession('restore-failed', '/repos/failing');
    connection.addSubscribedSession('restore-retained', '/repos/retained');

    connection.onSessionRestoreFailed?.('restore-failed');

    expect(sessionRegistry.sessions['restore-failed']).toBeUndefined();
    expect(connection.subscribedSessions.has('restore-failed')).toBe(false);
    expect(sessionRegistry.sessions['restore-retained']).toBeDefined();
    expect(connection.subscribedSessions.has('restore-retained')).toBe(true);
  });
});

describe('session_commands_changed', () => {
  it('replaces the cached commands after a resource reload', () => {
    const sessionId = 'commands-refresh';
    const commands = [{ name: 'skill:fresh-skill', description: 'Fresh skill', hasArgCompletions: false }];
    commandStore.setCommands(sessionId, [{ name: 'skill:old-skill', description: 'Old skill', hasArgCompletions: false }]);

    for (const listener of (connection as any).listeners) {
      listener({ type: 'session_commands_changed', sessionId, commands });
    }

    expect(commandStore.getCommands(sessionId)).toEqual(commands);
    commandStore.removeSession(sessionId);
  });
});

// --- Notification intent routing -------------------------------------------
// --- Folderless deep-link opens ------------------------------------------------
//
// openExistingSession on the module-level registry resolves a folderless
// deep-link open: the server searches its folders and reports the folder back,
// and the client records it on the session and the subscription map.

describe('session_opened lifecycle push', () => {
  const folder = {
    path: '/repos/target',
    name: 'target',
    nature: 'code' as const,
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 1,
    externalProcessCount: 0,
  };
  const emit = (sessionId = 'opened-target') => {
    for (const listener of (connection as any).listeners) listener({ type: 'session_opened', sessionId, folder });
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of ['opened-target', 'pending-placeholder', 'response-conflict']) {
      sessionRegistry.removeSession(id);
      connection.removeSubscribedSession(id);
    }
  });

  it('keeps a conflict banner sent after the response-owned initial snapshot', async () => {
    let resolveState!: (value: any) => void;
    let resolveMessages!: (value: any) => void;
    const stateSnapshot = new Promise<PimoteResponse>((resolve) => {
      resolveState = resolve;
    });
    const messagesSnapshot = new Promise<PimoteResponse>((resolve) => {
      resolveMessages = resolve;
    });
    const send = vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') {
        return {
          id: 'open',
          success: true,
          data: {
            sessionId: 'response-conflict',
            folderPath: '/repos/conflicted',
            folder: { ...folder, path: '/repos/conflicted', name: 'conflicted' },
          },
        };
      }
      if (cmd.type === 'get_state') return stateSnapshot;
      if (cmd.type === 'get_messages') return messagesSnapshot;
      if (cmd.type === 'get_session_meta') return { id: 'meta', success: true, data: { meta: { gitBranch: null, contextUsage: null, lifetimeCostUsd: 0 } } };
      if (cmd.type === 'get_commands') return { id: 'commands', success: true, data: { commands: [] } };
      return { id: cmd.id ?? 'snapshot', success: false };
    });

    const response = await openNewSession('/repos/conflicted');
    expect(response).toMatchObject({ success: true, data: { sessionId: 'response-conflict' } });
    expect(send.mock.calls.some(([cmd]) => cmd.type === 'get_state')).toBe(true);
    expect(send.mock.calls.some(([cmd]) => cmd.type === 'get_messages')).toBe(true);

    for (const listener of (connection as any).listeners) {
      listener({
        type: 'session_conflict',
        sessionId: 'response-conflict',
        processes: [{ pid: 1234, command: 'pi' }],
      });
    }

    resolveState({
      id: 'state',
      success: true,
      data: { state: { model: null, thinkingLevel: 'off', availableThinkingLevels: [], isStreaming: false, isCompacting: false, autoCompactionEnabled: false, messageCount: 0 } },
    });
    resolveMessages({ id: 'messages', success: true, data: { messages: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionRegistry.sessions['response-conflict'].conflictingProcesses).toEqual([{ pid: 1234, command: 'pi' }]);
    expect(send.mock.calls.filter(([cmd]) => cmd.type === 'open_session')).toHaveLength(1);
  });

  it('attaches once without navigating or consuming a placeholder', async () => {
    const send = vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') return { id: 'open', success: true, data: { sessionId: 'opened-target', folderPath: '/repos/target' } };
      return { id: cmd.id ?? 'resource', success: false };
    });
    sessionRegistry.addSession('pending-placeholder', '/repos/new', 'new');
    sessionRegistry.switchTo('pending-placeholder');
    emit();
    emit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send.mock.calls.filter(([cmd]) => cmd.type === 'open_session')).toHaveLength(1);
    expect(sessionRegistry.viewedSessionId).toBe('pending-placeholder');
    expect(connection.subscribedSessions.get('opened-target')).toBe('/repos/target');
    expect(send.mock.calls.some(([cmd]) => cmd.type === 'view_session')).toBe(false);
  });

  it('keeps drafts and transcripts for an already attached target', () => {
    sessionRegistry.addSession('opened-target', '/repos/target', 'target');
    const target = sessionRegistry.sessions['opened-target'];
    target.draftText = 'unsent';
    target.messages = [makeUserMessage('history')];
    connection.addSubscribedSession('opened-target', '/repos/target');
    const send = vi.spyOn(connection, 'send');
    emit();
    expect(send).not.toHaveBeenCalled();
    expect(target.draftText).toBe('unsent');
    expect(target.messages).toEqual([makeUserMessage('history')]);
  });
});

describe('parallel new sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of Object.keys(sessionRegistry.sessions)) {
      if (id.startsWith('parallel-') || id.startsWith('pending-') || id.startsWith('late-') || id.startsWith('failed-') || id === 'manager-target') {
        sessionRegistry.removeSession(id);
        connection.removeSubscribedSession(id);
      }
    }
    sessionRegistry.goHome();
  });

  it('reconciles parallel responses independently and preserves the viewed request', async () => {
    const resolvers: Array<(value: any) => void> = [];
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') return new Promise((resolve) => resolvers.push(resolve));
      return { id: cmd.id ?? 'resource', success: false };
    });
    const first = openNewSession('/repos/same');
    const second = openNewSession('/repos/same');
    expect(Object.keys(sessionRegistry.sessions).filter((id) => id.startsWith('pending-'))).toHaveLength(2);
    resolvers[1]({ id: 'second', success: true, data: { sessionId: 'parallel-2', folderPath: '/repos/same' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[0]({ id: 'first', success: true, data: { sessionId: 'parallel-1', folderPath: '/repos/same' } });
    await Promise.all([first, second]);
    expect(sessionRegistry.sessions['parallel-1']).toBeDefined();
    expect(sessionRegistry.sessions['parallel-2']).toBeDefined();
    expect(sessionRegistry.viewedSessionId).toBe('parallel-2');
  });

  it('attaches a same-folder manager push before a slow local open settles', async () => {
    let resolveLocal!: (value: any) => void;
    let openCalls = 0;
    const send = vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') {
        openCalls += 1;
        if (openCalls === 1) return new Promise((resolve) => (resolveLocal = resolve));
        return { id: `open-${openCalls}`, success: true, data: { sessionId: 'manager-target', folderPath: '/repos/target' } };
      }
      return { id: cmd.id ?? 'resource', success: false };
    });
    const local = openNewSession('/repos/target');
    for (const listener of (connection as any).listeners) {
      listener({
        type: 'session_opened',
        sessionId: 'manager-target',
        folder: {
          path: '/repos/target',
          name: 'target',
          nature: 'code',
          shortcutCount: 0,
          favorite: false,
          archived: false,
          tags: [],
          missing: false,
          activeSessionCount: 1,
          externalProcessCount: 0,
        },
      });
    }
    expect(openCalls).toBe(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', sessionId: 'manager-target' }));
    resolveLocal({ id: 'local-open', success: true, data: { sessionId: 'parallel-local', folderPath: '/repos/target' } });
    await local;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openCalls).toBe(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', sessionId: 'manager-target' }));
  });

  it('restores the pre-open view after a rejected response without choosing another active session', async () => {
    sessionRegistry.addSession('failure-other', '/repos/other', 'other');
    sessionRegistry.addSession('failure-previous', '/repos/previous', 'previous');
    sessionRegistry.switchTo('failure-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'open-failure', success: false, error: 'rejected' });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;

    await expect(opening).resolves.toMatchObject({ success: false, error: 'rejected' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBe('failure-previous');
    expect(toViewed).toHaveBeenLastCalledWith('failure-previous', { replace: true });
    expect(send).toHaveBeenCalledWith({ type: 'open_session', folderPath: '/repos/new' });

    sessionRegistry.removeSession('failure-previous');
    sessionRegistry.removeSession('failure-other');
    sessionRegistry.goHome();
  });

  it('restores the pre-open view after a connection error and returns the caller-facing error', async () => {
    sessionRegistry.addSession('failed-connection-other', '/repos/other', 'other');
    sessionRegistry.addSession('failed-connection-previous', '/repos/previous', 'previous');
    sessionRegistry.switchTo('failed-connection-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockRejectedValue(new Error('socket closed'));
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;

    await expect(opening).resolves.toMatchObject({ success: false, error: 'socket closed' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBe('failed-connection-previous');
    expect(toViewed).toHaveBeenLastCalledWith('failed-connection-previous', { replace: true });
  });

  it('restores the pre-open view when success has no real session id', async () => {
    sessionRegistry.addSession('failed-no-id-other', '/repos/other', 'other');
    sessionRegistry.addSession('failed-no-id-previous', '/repos/previous', 'previous');
    sessionRegistry.switchTo('failed-no-id-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'open-no-id', success: true, data: {} });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;

    await expect(opening).resolves.toMatchObject({ success: true, data: {} });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBe('failed-no-id-previous');
    expect(toViewed).toHaveBeenLastCalledWith('failed-no-id-previous', { replace: true });
  });

  it('keeps another parallel placeholder viewed when an earlier request fails', async () => {
    const resolvers: Array<(value: any) => void> = [];
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') return new Promise((resolve) => resolvers.push(resolve));
      return { id: cmd.id ?? 'resource', success: false };
    });

    const first = openNewSession('/repos/first');
    const firstPlaceholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;
    const second = openNewSession('/repos/second');
    const secondPlaceholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-') && id !== firstPlaceholder)!;

    resolvers[0]({ id: 'first-failure', success: false, error: 'first rejected' });
    await expect(first).resolves.toMatchObject({ success: false, error: 'first rejected' });
    expect(sessionRegistry.sessions[firstPlaceholder]).toBeUndefined();
    expect(sessionRegistry.sessions[secondPlaceholder]).toBeDefined();
    expect(sessionRegistry.viewedSessionId).toBe(secondPlaceholder);

    resolvers[1]({ id: 'second-failure', success: false, error: 'second rejected' });
    await expect(second).resolves.toMatchObject({ success: false, error: 'second rejected' });
    expect(sessionRegistry.viewedSessionId).toBeNull();
  });

  it('does not override deliberate home navigation after failure', async () => {
    sessionRegistry.addSession('failed-home-previous', '/repos/previous', 'previous');
    sessionRegistry.switchTo('failed-home-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'home-failure', success: false, error: 'rejected' });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;
    sessionRegistry.goHome();
    toViewed.mockClear();

    await expect(opening).resolves.toMatchObject({ success: false, error: 'rejected' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBeNull();
    expect(toViewed).not.toHaveBeenCalled();
  });

  it('does not override deliberate navigation to another session after failure', async () => {
    sessionRegistry.addSession('failed-other-previous', '/repos/previous', 'previous');
    sessionRegistry.addSession('failed-other-target', '/repos/target', 'target');
    sessionRegistry.switchTo('failed-other-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'other-failure', success: false, error: 'rejected' });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;
    sessionRegistry.switchTo('failed-other-target');
    toViewed.mockClear();

    await expect(opening).resolves.toMatchObject({ success: false, error: 'rejected' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBe('failed-other-target');
    expect(toViewed).not.toHaveBeenCalled();
  });

  it('goes home when the captured previous session is gone', async () => {
    sessionRegistry.addSession('failed-missing-other', '/repos/other', 'other');
    sessionRegistry.addSession('failed-missing-previous', '/repos/previous', 'previous');
    sessionRegistry.switchTo('failed-missing-previous');
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'missing-failure', success: false, error: 'rejected' });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;
    sessionRegistry.removeSession('failed-missing-previous');
    toViewed.mockClear();

    await expect(opening).resolves.toMatchObject({ success: false, error: 'rejected' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBeNull();
    expect(toViewed).toHaveBeenLastCalledWith(null, { replace: true });
  });

  it('goes home when the open began from the dashboard', async () => {
    sessionRegistry.addSession('failed-dashboard-other', '/repos/other', 'other');
    sessionRegistry.goHome();
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });
    toViewed.mockClear();

    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'dashboard-failure', success: false, error: 'rejected' });
    const opening = openNewSession('/repos/new');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;

    await expect(opening).resolves.toMatchObject({ success: false, error: 'rejected' });

    expect(sessionRegistry.sessions[placeholder]).toBeUndefined();
    expect(sessionRegistry.viewedSessionId).toBeNull();
    expect(toViewed).toHaveBeenLastCalledWith(null, { replace: true });
  });

  it('returns a rejected open through newSessionInProject', async () => {
    sessionRegistry.addSession('failed-caller', '/repos/caller', 'caller');
    sessionRegistry.switchTo('failed-caller');
    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'caller-failure', success: false, error: 'caller rejected' });

    await expect(newSessionInProject('failed-caller')).resolves.toMatchObject({ success: false, error: 'caller rejected' });
    expect(sessionRegistry.viewedSessionId).toBe('failed-caller');
  });

  it('closes a real session after a cancelled placeholder resolves late', async () => {
    let resolveOpen!: (value: any) => void;
    const send = vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.type === 'open_session') return new Promise((resolve) => (resolveOpen = resolve));
      return { id: cmd.id ?? 'resource', success: false };
    });
    const opening = openNewSession('/repos/late');
    const placeholder = Object.keys(sessionRegistry.sessions).find((id) => id.startsWith('pending-'))!;
    closeSession(placeholder);
    resolveOpen({ id: 'late-open', success: true, data: { sessionId: 'late-1', folderPath: '/repos/late' } });
    await expect(opening).resolves.toMatchObject({ success: false, error: 'session_open_cancelled' });
    expect(sessionRegistry.sessions['late-1']).toBeUndefined();
    for (const listener of (connection as any).listeners) {
      listener({
        type: 'session_opened',
        sessionId: 'late-1',
        folder: {
          path: '/repos/late',
          name: 'late',
          nature: 'code',
          shortcutCount: 0,
          favorite: false,
          archived: false,
          tags: [],
          missing: false,
          activeSessionCount: 1,
          externalProcessCount: 0,
        },
      });
    }
    expect(sessionRegistry.sessions['late-1']).toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'close_session', sessionId: 'late-1' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'close_session', sessionId: placeholder }));

    for (const listener of (connection as any).listeners) listener({ type: 'session_closed', sessionId: 'late-1' });
    for (const listener of (connection as any).listeners) {
      listener({
        type: 'session_opened',
        sessionId: 'late-1',
        folder: {
          path: '/repos/late',
          name: 'late',
          nature: 'code',
          shortcutCount: 0,
          favorite: false,
          archived: false,
          tags: [],
          missing: false,
          activeSessionCount: 1,
          externalProcessCount: 0,
        },
      });
    }
    expect(sessionRegistry.sessions['late-1']).toBeDefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_session', sessionId: 'late-1' }));
    resolveOpen({ id: 'legitimate-open', success: true, data: { sessionId: 'late-1', folderPath: '/repos/late' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionRegistry.sessions['late-1'].restorable).toBe(true);
  });
});

describe('openExistingSession (folderless deep link)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionRegistry.removeSession('s-deep');
    connection.removeSubscribedSession('s-deep');
    connection.removeSubscribedSession('s-folder-patch');
  });

  it('records the folder resolved by the server on the session and subscription', async () => {
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => ({
      id: cmd.id ?? 'test',
      success: cmd.type === 'open_session',
      data: cmd.type === 'open_session' ? { sessionId: 's-deep', folderPath: '/repos/proj' } : undefined,
    }));

    const opened = await openExistingSession('s-deep', undefined, { switchTo: false });

    expect(opened).toBe(true);
    expect(sessionRegistry.sessions['s-deep'].folderPath).toBe('/repos/proj');
    expect(sessionRegistry.sessions['s-deep'].projectName).toBe('proj');
    expect(connection.subscribedSessions.get('s-deep')).toBe('/repos/proj');
  });

  it('setSessionFolder() patches folder, project name, and nothing for unknown ids', () => {
    sessionRegistry.addSession('s-folder-patch', '', 'Unknown');
    sessionRegistry.setSessionFolder('s-folder-patch', '/repos/proj');
    expect(sessionRegistry.sessions['s-folder-patch'].folderPath).toBe('/repos/proj');
    expect(sessionRegistry.sessions['s-folder-patch'].projectName).toBe('proj');

    expect(() => sessionRegistry.setSessionFolder('s-unknown', '/repos/proj')).not.toThrow();
  });
});

// --- Restored sessions keep their folder row --------------------------------
//
// open_session on an existing session answers with the session's folder row;
// the client binds it so the chip glyph keeps the folder's nature and hub
// facts across an app restart (no session_opened event fires on restore).

describe('openExistingSession (folder binding)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionRegistry.removeSession('s-bind');
    connection.removeSubscribedSession('s-bind');
  });

  it('binds the folder row from the open_session response', async () => {
    const folderRow: FolderInfo = {
      path: '/repos/agent',
      name: 'agent',
      nature: 'persona',
      shortcutCount: 2,
      favorite: false,
      archived: false,
      tags: [],
      missing: false,
      activeSessionCount: 0,
      externalProcessCount: 0,
    };
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => ({
      id: cmd.id ?? 'test',
      success: cmd.type === 'open_session',
      data: cmd.type === 'open_session' ? { sessionId: 's-bind', folderPath: '/repos/agent', folder: folderRow } : undefined,
    }));

    const opened = await openExistingSession('s-bind', '/repos/agent', { switchTo: false });

    expect(opened).toBe(true);
    expect(sessionRegistry.sessions['s-bind'].folder).toMatchObject({
      path: '/repos/agent',
      nature: 'persona',
      shortcutCount: 2,
    });
  });
});

// --- Reconnect restore keeps its folder row --------------------------------
//
// After a restart the connection store's restore loop owns the open_session
// calls; it delivers each response through connection.onSessionRestored. The
// registry rebinds the folder row so the chip glyph keeps the folder's nature
// and hub facts (restores emit no session_opened event).

describe('reconnect restore (connection.onSessionRestored)', () => {
  afterEach(() => {
    sessionRegistry.removeSession('s-hydrate');
    connection.removeSubscribedSession('s-hydrate');
  });

  it('binds the folder row delivered for a hydrated session', () => {
    sessionRegistry.addSession('s-hydrate', '/repos/agent', 'agent');
    connection.addSubscribedSession('s-hydrate', '/repos/agent');
    expect(sessionRegistry.sessions['s-hydrate'].folder).toBeNull();

    const folderRow: FolderInfo = {
      path: '/repos/agent',
      name: 'agent',
      nature: 'persona',
      shortcutCount: 2,
      favorite: false,
      archived: false,
      tags: [],
      missing: false,
      activeSessionCount: 0,
      externalProcessCount: 0,
    };
    connection.onSessionRestored!('s-hydrate', { sessionId: 's-hydrate', folderPath: '/repos/agent', folder: folderRow });

    expect(sessionRegistry.sessions['s-hydrate'].folder).toMatchObject({
      path: '/repos/agent',
      nature: 'persona',
      shortcutCount: 2,
    });
  });
});

// --- Restore rejected with session_not_found --------------------------------
//
// A session the server no longer knows (never persisted, pruned idle slot)
// must be deleted locally on every path that surfaces the rejection: the
// reconnect restore loop (connection.onSessionNotFound) and explicit
// openExistingSession calls on an already-tracked session.

describe('session_not_found cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionRegistry.removeSession('s-orphan');
    connection.removeSubscribedSession('s-orphan');
  });

  it('openExistingSession drops an already-tracked orphan instead of keeping it', async () => {
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => ({
      id: cmd.id ?? 'test',
      success: false,
      error: cmd.type === 'open_session' ? 'session_not_found' : 'other',
    }));

    sessionRegistry.addSession('s-orphan', '/repos/proj', 'proj');
    connection.addSubscribedSession('s-orphan', '/repos/proj');
    // Sanity: the orphan is tracked before the open attempt.
    expect(sessionRegistry.sessions['s-orphan']).toBeDefined();

    const opened = await openExistingSession('s-orphan', '/repos/proj', { switchTo: false });

    expect(opened).toBe(false);
    expect(sessionRegistry.sessions['s-orphan']).toBeUndefined();
    expect(connection.subscribedSessions.has('s-orphan')).toBe(false);
  });

  it('a transient failure still keeps an already-tracked session', async () => {
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => ({
      id: cmd.id ?? 'test',
      success: false,
      error: cmd.type === 'open_session' ? 'internal_error' : 'other',
    }));

    sessionRegistry.addSession('s-orphan', '/repos/proj', 'proj');
    connection.addSubscribedSession('s-orphan', '/repos/proj');

    const opened = await openExistingSession('s-orphan', '/repos/proj', { switchTo: false });

    expect(opened).toBe(false);
    expect(sessionRegistry.sessions['s-orphan']).toBeDefined();
    expect(connection.subscribedSessions.has('s-orphan')).toBe(true);
  });

  it('an archived open drops the session from the restore set without deleting its local transcript', async () => {
    vi.spyOn(connection, 'send').mockImplementation(async (cmd: any) => ({
      id: cmd.id ?? 'test',
      success: false,
      error: cmd.type === 'open_session' ? 'session_archived' : 'other',
    }));

    sessionRegistry.addSession('s-archived', '/repos/proj', 'proj');
    connection.addSubscribedSession('s-archived', '/repos/proj');
    sessionRegistry.sessions['s-archived'].messages = [makeUserMessage('keep transcript')];

    const opened = await openExistingSession('s-archived', '/repos/proj', { switchTo: false });

    expect(opened).toBe(false);
    expect(sessionRegistry.sessions['s-archived'].messages).toEqual([makeUserMessage('keep transcript')]);
    expect(connection.subscribedSessions.has('s-archived')).toBe(false);
  });

  it('the reconnect-restore callback (connection.onSessionNotFound) deletes the orphan', () => {
    sessionRegistry.addSession('s-orphan', '/repos/proj', 'proj');
    connection.addSubscribedSession('s-orphan', '/repos/proj');

    connection.onSessionNotFound?.('s-orphan');

    expect(sessionRegistry.sessions['s-orphan']).toBeUndefined();
    expect(connection.subscribedSessions.has('s-orphan')).toBe(false);
  });
});

// routeNotificationIntent uses the module-level connection singleton, so it
// needs the same global stubs as connection.svelte.test.ts before connect()
// can run.

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

  static instances: FakeWebSocket[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSING;
  }
}

describe('reconnect restore attachment cache', () => {
  const sessionIds = ['cache-hydrated', 'cache-reconnect', 'cache-transient', 'cache-not-found', 'cache-removed', 'cache-queued'];
  const folder = {
    path: '/repos/cache',
    name: 'cache',
    nature: 'code' as const,
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 1,
    externalProcessCount: 0,
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const commands = (ws: FakeWebSocket): Array<Record<string, any>> => ws.sent.map((raw) => JSON.parse(raw));
  const openCommands = (ws: FakeWebSocket) => commands(ws).filter((command) => command.type === 'open_session');
  const respondToOpen = (ws: FakeWebSocket, response: { success: boolean; error?: string; data?: unknown }): void => {
    const open = openCommands(ws)[0];
    if (!open) throw new Error('no open_session command');
    ws.onmessage!({ data: JSON.stringify({ id: open.id, ...response }) });
  };
  const emitOpened = (ws: FakeWebSocket, sessionId: string): void => {
    ws.onmessage!({ data: JSON.stringify({ type: 'session_opened', sessionId, folder }) });
  };

  beforeEach(() => {
    connection.disconnect();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
    vi.stubGlobal('navigator', {});
    for (const sessionId of sessionIds) {
      sessionRegistry.removeSession(sessionId);
      connection.removeSubscribedSession(sessionId);
    }
  });

  afterEach(() => {
    const ws = FakeWebSocket.instances.at(-1);
    connection.disconnect();
    if (ws?.onclose) {
      ws.readyState = FakeWebSocket.CLOSED;
      ws.onclose();
    }
    for (const sessionId of sessionIds) {
      sessionRegistry.removeSession(sessionId);
      connection.removeSubscribedSession(sessionId);
    }
    vi.unstubAllGlobals();
  });

  it('caches a hydrated restore before duplicate manager lifecycle pushes', async () => {
    const sessionId = 'cache-hydrated';
    sessionRegistry.addSession(sessionId, folder.path, folder.name);
    connection.addSubscribedSession(sessionId, folder.path);

    connection.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    respondToOpen(ws, { success: true, data: { sessionId, folderPath: folder.path, restoreMode: 'full_resync_no_cursor' } });
    await flush();

    emitOpened(ws, sessionId);
    emitOpened(ws, sessionId);
    await flush();

    expect(openCommands(ws)).toHaveLength(1);
    expect(commands(ws).filter((command) => command.type === 'get_state' || command.type === 'get_messages')).toHaveLength(0);
  });

  it('sends a restore again after disconnect clears the attachment cache', async () => {
    const sessionId = 'cache-reconnect';
    sessionRegistry.addSession(sessionId, folder.path, folder.name);
    connection.addSubscribedSession(sessionId, folder.path);

    connection.connect();
    const first = FakeWebSocket.instances.at(-1)!;
    first.readyState = FakeWebSocket.OPEN;
    first.onopen!();
    respondToOpen(first, { success: true, data: { sessionId, folderPath: folder.path } });
    await flush();

    first.readyState = FakeWebSocket.CLOSED;
    first.onclose!();
    connection.connect();
    const second = FakeWebSocket.instances.at(-1)!;
    second.readyState = FakeWebSocket.OPEN;
    second.onopen!();
    respondToOpen(second, { success: true, data: { sessionId, folderPath: folder.path } });
    await flush();
    emitOpened(second, sessionId);
    emitOpened(second, sessionId);
    await flush();

    expect(openCommands(second)).toHaveLength(1);
  });

  it.each([
    ['cache-transient', 'internal_error'],
    ['cache-not-found', 'session_not_found'],
  ] as const)('does not cache a %s restore failure (%s)', async (sessionId, error) => {
    sessionRegistry.addSession(sessionId, folder.path, folder.name);
    connection.addSubscribedSession(sessionId, folder.path);

    connection.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    respondToOpen(ws, { success: false, error });
    await flush();

    emitOpened(ws, sessionId);
    await flush();

    expect(openCommands(ws)).toHaveLength(2);
  });

  it('does not cache a restore response that arrives after local removal', async () => {
    const sessionId = 'cache-removed';
    sessionRegistry.addSession(sessionId, folder.path, folder.name);
    connection.addSubscribedSession(sessionId, folder.path);

    connection.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    sessionRegistry.removeSession(sessionId);
    connection.removeSubscribedSession(sessionId);
    respondToOpen(ws, { success: true, data: { sessionId, folderPath: folder.path } });
    await flush();

    expect(sessionRegistry.sessions[sessionId]).toBeUndefined();
    expect(connection.subscribedSessions.has(sessionId)).toBe(false);

    emitOpened(ws, sessionId);
    await flush();

    expect(openCommands(ws)).toHaveLength(2);
  });

  it('does not repopulate the cache when success is queued before socket drop', async () => {
    const sessionId = 'cache-queued';
    sessionRegistry.addSession(sessionId, folder.path, folder.name);
    connection.addSubscribedSession(sessionId, folder.path);

    connection.connect();
    const first = FakeWebSocket.instances.at(-1)!;
    first.readyState = FakeWebSocket.OPEN;
    first.onopen!();
    respondToOpen(first, { success: true, data: { sessionId, folderPath: folder.path } });
    first.readyState = FakeWebSocket.CLOSED;
    first.onclose!();
    await flush();

    connection.connect();
    const second = FakeWebSocket.instances.at(-1)!;
    second.readyState = FakeWebSocket.OPEN;
    second.onopen!();
    emitOpened(second, sessionId);

    expect(openCommands(second)).toHaveLength(2);
  });
});

describe('routeNotificationIntent', () => {
  beforeEach(() => {
    connection.disconnect();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
    vi.stubGlobal('navigator', {});
    connection.ready = false;
    connection.pendingAdopt = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    connection.pendingAdopt = null;
    connection.ready = false;
    connection.removeSubscribedSession('s-notification');
    connection.removeSubscribedSession('s-folderless-intent');
  });

  it('queues the adopt intent when the socket is not ready instead of losing the click', async () => {
    await routeNotificationIntent({ sessionId: 's-notification', folderPath: '/repos/proj' });

    expect(connection.pendingAdopt).toEqual({ sessionId: 's-notification', folderPath: '/repos/proj' });
  });

  it('routes immediately without queueing when the socket is ready and the session is open', async () => {
    connection.ready = true;
    sessionRegistry.addSession('s-notification', '/repos/proj', 'proj');

    await routeNotificationIntent({ sessionId: 's-notification', folderPath: '/repos/proj' });

    expect(connection.pendingAdopt).toBeNull();
    expect(sessionRegistry.viewed?.sessionId).toBe('s-notification');
  });

  it('resolves the folder from subscribed sessions when the intent carries no folderPath', async () => {
    connection.addSubscribedSession('s-folderless-intent', '/repos/proj');

    await routeNotificationIntent({ sessionId: 's-folderless-intent' });

    expect(connection.pendingAdopt).toEqual({ sessionId: 's-folderless-intent', folderPath: '/repos/proj' });
  });
});

// --- Cold boot from a notification click -----------------------------------
// The service worker opens /?sessionId=..&folderPath=.. with no window clients
// around; +layout turns that into pendingAdopt before connect(). Pinned here:
// the intent must be consumed on the first successful open and routed to the
// session URL, not left on the dashboard.

describe('cold-boot notification adoption', () => {
  beforeEach(() => {
    connection.disconnect();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
    vi.stubGlobal('navigator', {});
    connection.ready = false;
    connection.pendingAdopt = null;
  });

  afterEach(() => {
    connection.disconnect();
    vi.unstubAllGlobals();
    connection.pendingAdopt = null;
    connection.ready = false;
  });

  it('consumes pendingAdopt on connect and routes to the session URL', async () => {
    const toViewed = vi.fn();
    sessionRegistry.setViewNavigator({ toViewed });

    connection.pendingAdopt = { sessionId: 's-cold-boot', folderPath: '/repos/proj' };
    connection.connect();

    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toViewed).toHaveBeenCalledWith('s-cold-boot', { replace: false });
    expect(connection.pendingAdopt).toBeNull();
  });
});
