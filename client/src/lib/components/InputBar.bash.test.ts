// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import InputBar from './InputBar.svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';

function setupSession(streaming = false) {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  sessionRegistry.sessions.s1.isStreaming = streaming;
  connection.ready = true;
  return sessionRegistry.sessions.s1;
}

function render() {
  const target = document.createElement('div');
  const component = mount(InputBar, { target });
  return { target, destroy: () => unmount(component) };
}

async function enterAndSubmit(target: HTMLElement, text: string) {
  const textarea = target.querySelector('textarea')!;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  const send = target.querySelector('button[title="Send"], button[title="Steer"]') as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  send.click();
  await tick();
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
});

describe('InputBar native bang command boundary', () => {
  it('starts a caller-correlated bash command while the model streams instead of steering it', async () => {
    const session = setupSession(true);
    const send = vi.spyOn(connection, 'send').mockImplementation(() => new Promise(() => {}));
    const view = render();

    await enterAndSubmit(view.target, '!pwd');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bash',
        sessionId: 's1',
        command: 'pwd',
        excludeFromContext: false,
        id: expect.any(String),
      }),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'steer' }));

    const command = send.mock.calls[0][0] as Extract<Parameters<typeof connection.send>[0], { type: 'bash' }>;
    expect(session.bashExecutions[command.id!]).toMatchObject({ id: command.id, command: 'pwd', status: 'running' });

    view.destroy();
  });

  it('recognizes !! before ! and preserves context exclusion while streaming', async () => {
    setupSession(true);
    const send = vi.spyOn(connection, 'send').mockImplementation(() => new Promise(() => {}));
    const view = render();

    await enterAndSubmit(view.target, '  !!   git status --short  ');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bash',
        sessionId: 's1',
        command: 'git status --short',
        excludeFromContext: true,
        id: expect.any(String),
      }),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'steer' }));

    view.destroy();
  });

  it('leaves a bare bang on the ordinary prompt path', async () => {
    setupSession();
    const send = vi.spyOn(connection, 'send').mockResolvedValue({ id: 'prompt-1', success: true } as never);
    const view = render();

    await enterAndSubmit(view.target, '!');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', sessionId: 's1', message: '!' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bash' }));

    view.destroy();
  });

  it('keeps an unsuccessful bash response visible as a dispatch error', async () => {
    const session = setupSession();
    vi.spyOn(connection, 'send').mockResolvedValue({ id: 'bash-error', success: false, error: 'bash_already_running' } as never);
    const view = render();

    await enterAndSubmit(view.target, '!pwd');
    await Promise.resolve();
    await tick();

    expect(Object.values(session.bashExecutions)).toContainEqual(expect.objectContaining({ command: 'pwd', status: 'error', error: 'bash_already_running' }));

    view.destroy();
  });

  it('keeps a socket-drop outcome pending instead of converting it into a dispatch error', async () => {
    const session = setupSession();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.spyOn(connection, 'send').mockRejectedValue(new Error('WebSocket closed'));
    const view = render();

    await enterAndSubmit(view.target, '!pwd');
    await Promise.resolve();
    await tick();

    const command = send.mock.calls.find(([request]) => request.type === 'bash')?.[0] as Extract<Parameters<typeof connection.send>[0], { type: 'bash' }>;
    expect(command).toBeDefined();
    expect(session.bashExecutions[command.id!]).toMatchObject({ command: 'pwd', status: 'running' });
    expect(session.bashExecutions[command.id!].error).toBeUndefined();

    view.destroy();
  });

  it('recovers an accepted command from a reconnect snapshot without re-dispatching it', async () => {
    const session = setupSession();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi
      .spyOn(connection, 'send')
      .mockRejectedValueOnce(new Error('WebSocket closed'))
      .mockImplementation(async (request) => {
        if (request.type === 'get_messages') {
          return {
            id: request.id ?? 'messages',
            success: true,
            data: {
              messages: [
                {
                  role: 'bashExecution',
                  content: [{ type: 'text', text: '$ pwd\n/workspace/project' }],
                  command: 'pwd',
                  output: '/workspace/project',
                  cancelled: false,
                  truncated: false,
                  excludeFromContext: false,
                },
              ],
            },
          } as never;
        }
        return { id: request.id ?? 'request', success: true } as never;
      });
    const view = render();

    await enterAndSubmit(view.target, '!pwd');
    await Promise.resolve();
    await tick();
    const bashRequestCount = () => send.mock.calls.filter(([request]) => request.type === 'bash').length;
    expect(bashRequestCount()).toBe(1);

    connection.onReconnected?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();

    expect(bashRequestCount()).toBe(1);
    expect(session.bashExecutions).toEqual({});
    expect(session.messages).toContainEqual(expect.objectContaining({ role: 'bashExecution', command: 'pwd', output: '/workspace/project' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'get_messages', sessionId: 's1' }));

    view.destroy();
  });
});
