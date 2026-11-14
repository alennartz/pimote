// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe.each([
  ['branchSummary', 'branch summary'],
  ['compactionSummary', 'context compacted'],
])('%s messages', (role, label) => {
  it('renders collapsed and expands the summary on click', async () => {
    const target = document.createElement('div');
    const message: PimoteAgentMessage = {
      role,
      content: [{ type: 'text', text: 'the summary text' }],
    };
    const component = mount(Message, {
      target,
      props: { message },
    });
    destroy = () => unmount(component);

    await tick();

    const header = target.querySelector<HTMLButtonElement>('.system-chip-header');
    expect(header?.textContent).toContain(label);
    expect(target.querySelector('.system-chip-body')).toBeNull();

    header?.click();
    await tick();

    expect(target.querySelector('.system-chip-body')?.textContent).toContain('the summary text');

    header?.click();
    await tick();

    expect(target.querySelector('.system-chip-body')).toBeNull();
  });
});
