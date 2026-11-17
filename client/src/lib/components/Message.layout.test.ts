// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { AssistantRowUsage, PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

const rowUsage: AssistantRowUsage = {
  totalCostUsd: 0.13,
  breakdown: {
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
    cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0 },
  },
};

describe('Message assistant cost layout', () => {
  it('discloses the cost in the speaker row above the content', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(Message, {
        target,
        props: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as PimoteAgentMessage,
          assistantRowUsage: rowUsage,
        },
      }),
    );
    await tick();

    const speakerRow = target.querySelector<HTMLElement>('.assistant-meta');
    expect(speakerRow).not.toBeNull();
    expect(speakerRow!.querySelector('.assistant-icon')).not.toBeNull();
    expect(speakerRow!.querySelector('.assistant-cost')).not.toBeNull();
    expect(target.querySelector('.message-body .assistant-cost')).toBeNull();
  });
});
