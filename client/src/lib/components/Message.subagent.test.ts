// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

function message(phase: 'ready' | 'sending' | 'waiting' | 'responding' | 'complete'): PimoteAgentMessage {
  const request = phase === 'ready' ? '' : phase === 'sending' ? 'Please verify' : 'Please verify the configuration.';
  const response = phase === 'responding' ? 'Everything required' : phase === 'complete' ? 'Everything required is present.' : '';
  return {
    role: 'assistant',
    entryId: 'assistant-entry',
    content: [
      { type: 'text', text: 'I will ask the worker.' },
      {
        type: 'subagent',
        operationId: 'send-call',
        subagentKind: 'send',
        subagentState: phase === 'complete' ? 'complete' : 'active',
        placement: { toolCallId: 'send-call', contentIndex: 1 },
        data: phase === 'complete' ? { operation: 'send', to: ['worker'], request, response } : { operation: 'send', to: ['worker'], request, response, phase },
      },
      { type: 'text', text: 'I will inspect the local file too.' },
      { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
    ],
  };
}

describe('inline subagent send rendering', () => {
  it.each(['ready', 'sending', 'waiting', 'responding', 'complete'] as const)('renders the %s state in the mixed assistant row', async (phase) => {
    const target = document.createElement('div');
    component = mount(Message, { target, props: { message: message(phase) } });
    await tick();
    const text = target.textContent ?? '';
    const card = target.querySelector('[aria-label="Subagent send operation"]');
    expect(card).not.toBeNull();
    expect(card!.textContent?.toLowerCase()).toContain(phase);
    expect(card!.textContent).toContain('worker');
    const body = phase === 'ready' ? 'Ready to send.' : 'Please verify';
    expect(card!.textContent).toContain(body);
    expect(text.indexOf('I will ask the worker.')).toBeLessThan(text.indexOf(body));
    expect(text.indexOf(body)).toBeLessThan(text.indexOf('I will inspect the local file too.'));
    expect(text).toContain('read');
    if (phase === 'responding' || phase === 'complete') expect(card!.textContent).toContain('Everything required');
    else expect(card!.textContent).not.toContain('Everything required');
  });
});
