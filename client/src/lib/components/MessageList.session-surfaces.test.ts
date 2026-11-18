// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PimoteSessionEvent } from '@pimote/shared';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: new Proxy(
    {
      status: 'connected',
      managerRoot: null,
      send: vi.fn(async () => ({
        success: true,
        data: { steering: ['queued question'], followUp: [] },
      })),
    },
    {
      get(target, property) {
        return property in target ? target[property as keyof typeof target] : vi.fn();
      },
    },
  ),
}));
const { default: MessageList } = await import('$lib/components/MessageList.svelte');
const { default: InputBar } = await import('$lib/components/InputBar.svelte');
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  sessionRegistry.sessions = {};
  sessionRegistry.clearSubagentRoot('root');
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture(kind: 'root' | 'child') {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  sessionRegistry.addSession('root', '/workspace', 'workspace');
  sessionRegistry.switchTo('root');
  const path = ['worker'];
  let cursor = 0;
  if (kind === 'child') {
    sessionRegistry.handleEvent({
      type: 'subagent_view_snapshot',
      sessionId: 'root',
      childSessionId: 'child',
      path,
      incarnation: 'inc',
      viewCursor: cursor,
      state: {
        sessionId: 'child',
        sessionFile: undefined,
        model: null,
        thinkingLevel: 'high',
        availableThinkingLevels: [],
        isStreaming: true,
        isCompacting: false,
        autoCompactionEnabled: false,
        messageCount: 0,
      },
      messages: [],
    });
    sessionRegistry.selectSubagentView('root', path);
  }
  const dispatch = (type: string, payload: Record<string, unknown> = {}) => {
    const event = { type, sessionId: kind === 'child' ? 'child' : 'root', cursor: ++cursor, ...payload } as PimoteSessionEvent;
    sessionRegistry.handleEvent(
      kind === 'child'
        ? {
            type: 'subagent_view_event',
            sessionId: 'root',
            childSessionId: 'child',
            path,
            incarnation: 'inc',
            viewCursor: cursor,
            event,
          }
        : event,
    );
    flushSync();
  };
  return {
    path,
    dispatch,
    get surface() {
      return kind === 'child' ? sessionRegistry.getSubagentAttachment('root', path)! : sessionRegistry.sessions.root;
    },
    mount() {
      const target = document.createElement('div');
      document.body.append(target);
      component = mount(MessageList, { target });
      flushSync();
      return target;
    },
  };
}

describe.each(['root', 'child'] as const)('%s live behavior', (kind) => {
  it('keeps keyboard focus on the tool while bash arguments stream', () => {
    const f = fixture(kind);
    f.dispatch('agent_start');
    f.dispatch('message_start', { role: 'assistant' });
    f.dispatch('message_update', {
      subtype: 'start',
      contentIndex: 0,
      content: { type: 'tool_call', text: '' },
      toolCallId: 'bash-call',
      toolName: 'bash',
    });
    f.dispatch('message_update', {
      subtype: 'delta',
      contentIndex: 0,
      content: { type: 'tool_call', text: '{"command":"printf hello' },
    });
    const target = f.mount();
    const header = [...target.querySelectorAll('button')].find((button) => button.textContent?.includes('bash'))!;
    expect(header).not.toBeNull();
    header.focus();
    expect(document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent?.includes('bash')).toBe(true);
    f.dispatch('message_update', {
      subtype: 'delta',
      contentIndex: 0,
      content: { type: 'tool_call', text: ' world"}' },
    });
    expect(document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent?.includes('bash')).toBe(true);
  });

  it('keeps the reasoning disclosure open when the assistant message finishes', () => {
    const f = fixture(kind);
    f.dispatch('agent_start');
    f.dispatch('message_start', { role: 'assistant' });
    f.dispatch('message_update', { subtype: 'start', contentIndex: 0, content: { type: 'thinking', text: '' } });
    f.dispatch('message_update', {
      subtype: 'delta',
      contentIndex: 0,
      content: { type: 'thinking', text: 'Compare both session paths and keep each reasoning disclosure open until the reader closes it.' },
    });
    const target = f.mount();
    expect(target.textContent).toContain('Compare both session paths and keep each reasoning disclosure open until the reader closes it.');
    f.dispatch('message_end', {
      message: { role: 'assistant', content: [{ type: 'thinking', text: 'Compare both session paths and keep each reasoning disclosure open until the reader closes it.' }] },
    });
    expect(target.textContent).toContain('Compare both session paths and keep each reasoning disclosure open until the reader closes it.');
  });

  it('returns queued text to the composer after Abort', async () => {
    const f = fixture(kind);
    f.surface.draftText = 'keep draft';
    f.dispatch('agent_start');
    f.dispatch('queue_update', { steering: ['queued question'], followUp: [] });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(InputBar, { target });
    flushSync();
    target.querySelector<HTMLButtonElement>('button[title="Abort"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value).toBe('queued question\nkeep draft');
    });
  });
});
