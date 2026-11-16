// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

const mounted: ReturnType<typeof mount>[] = [];

function render(message: PimoteAgentMessage): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(Message, { target, props: { message } }));
  return target;
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

describe('transcript image content', () => {
  it('renders user images beside the message text and lets the reader expand them', async () => {
    const target = render({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', image: { data: 'AQIDBA==', mimeType: 'image/png' } },
      ],
    });
    await tick();

    const image = target.querySelector<HTMLImageElement>('.user-message img');
    expect(target.textContent).toContain('What is in this picture?');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==');
    expect(image?.getAttribute('alt')).toBe('User attachment 1');

    const preview = target.querySelector<HTMLButtonElement>('.user-message button[aria-label="Open image full screen"]');
    preview?.click();
    await tick();
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"] img')?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==');
  });

  it('renders server-backed image refs without rebuilding an inline data URL', async () => {
    const url = `/i/${'b'.repeat(64)}`;
    const target = render({ role: 'assistant', content: [{ type: 'image', image: { url, mimeType: 'image/png' } }] });
    await tick();
    expect(target.querySelector<HTMLImageElement>('.assistant-message img')?.getAttribute('src')).toBe(url);
  });

  it('renders image blocks in assistant messages', async () => {
    const target = render({
      role: 'assistant',
      content: [{ type: 'image', image: { data: 'AQIDBA==', mimeType: 'image/webp' } }],
    });
    await tick();

    expect(target.querySelector<HTMLImageElement>('.assistant-message img')?.getAttribute('src')).toBe('data:image/webp;base64,AQIDBA==');
  });
});
