// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import MessageList from './MessageList.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';

function setupSession() {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  return sessionRegistry.sessions.s1;
}

function render() {
  const target = document.createElement('div');
  const component = mount(MessageList, { target });
  return { target, destroy: () => unmount(component) };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
});

describe('MessageList native bash display boundary', () => {
  it('renders a running bash entry after persisted chat and cancels it without aborting the model', async () => {
    const session = setupSession();
    session.messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect the project' }] }];
    session.messageKeys = ['msg-1'];
    session.isStreaming = true;
    session.bashExecutions = {
      'bash-1': {
        id: 'bash-1',
        command: 'pwd',
        excludeFromContext: false,
        output: '/workspace/project\n',
        status: 'running',
      },
    };
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'abort-1', success: true } as never);
    const view = render();

    const chatIndex = view.target.textContent!.indexOf('Inspect the project');
    const bashIndex = view.target.textContent!.indexOf('$ pwd');
    expect(chatIndex).toBeGreaterThanOrEqual(0);
    expect(bashIndex).toBeGreaterThan(chatIndex);
    expect(view.target.querySelector('[data-testid="bash-execution"]')).not.toBeNull();

    const cancel = Array.from(view.target.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Cancel');
    expect(cancel).toBeDefined();
    cancel!.click();
    await tick();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'abort_bash', sessionId: 's1' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort' }));

    view.destroy();
  });

  it('keeps a failed dispatch visible as a non-context bash entry', () => {
    const session = setupSession();
    session.bashExecutions = {
      'bash-error': {
        id: 'bash-error',
        command: 'pwd',
        excludeFromContext: false,
        output: '',
        status: 'error',
        error: 'WebSocket closed',
      },
    };
    const view = render();

    expect(view.target.querySelector('[data-testid="bash-execution"]')).not.toBeNull();
    expect(view.target.textContent).toContain('WebSocket closed');

    view.destroy();
  });

  it('renders a finalized persisted bashExecution through the dedicated presenter', () => {
    const session = setupSession();
    session.messages = [
      {
        role: 'bashExecution',
        content: [{ type: 'text', text: '$ git status --short\n M src/index.ts' }],
        command: 'git status --short',
        output: ' M src/index.ts',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    ];
    session.messageKeys = ['msg-bash'];
    const view = render();

    expect(view.target.querySelector('[data-testid="bash-execution"]')).not.toBeNull();
    expect(view.target.textContent).toContain('$ git status --short');
    expect(view.target.textContent).toContain(' M src/index.ts');

    view.destroy();
  });
});
