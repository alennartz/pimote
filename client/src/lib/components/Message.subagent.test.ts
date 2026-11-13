// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
  document.body.replaceChildren();
});

function projectedMessage(state: 'active' | 'complete' = 'active'): PimoteAgentMessage {
  return {
    role: 'assistant',
    entryId: 'assistant-entry',
    content: [
      { type: 'text', text: 'I will ask the worker. ' },
      {
        type: 'subagent',
        operationId: 'send-call',
        subagentKind: 'send',
        subagentState: state,
        placement: { toolCallId: 'send-call', contentIndex: 1, entryId: 'assistant-entry' },
        data: {
          operation: 'send',
          body: state === 'active' ? 'Please verify the configuration.' : 'Please verify the configuration. Response: complete.',
        },
        streaming: state === 'active',
      },
      { type: 'text', text: ' I will inspect the local file too.' },
      { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
    ],
  };
}

describe('projected subagent message content', () => {
  it('renders a semantic block inline with surrounding assistant text and unrelated native tools', async () => {
    const target = document.createElement('div');
    const component = mount(Message, { target, props: { message: projectedMessage() } });
    destroy = () => unmount(component);
    await tick();

    expect(target.textContent).toContain('I will ask the worker.');
    expect(target.textContent).toContain('Please verify the configuration.');
    expect(target.textContent).toContain('I will inspect the local file too.');
    expect(target.textContent).toContain('read');
    expect(target.querySelector('[aria-label="Subagent send operation"]')).not.toBeNull();
    expect(target.textContent).not.toContain('send-call');
  });

  it('shows the complete response payload after replay without rendering a native replacement card', async () => {
    const target = document.createElement('div');
    const component = mount(Message, { target, props: { message: projectedMessage('complete') } });
    destroy = () => unmount(component);
    await tick();

    expect(target.textContent).toContain('Response: complete.');
    expect(target.querySelectorAll('[aria-label="Subagent send operation"]').length).toBe(1);
    expect(Array.from(target.querySelectorAll('.tool-name')).map((item) => item.textContent)).not.toContain('send');
  });
});
