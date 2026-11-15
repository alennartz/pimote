// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ToolCall from './ToolCall.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('tool results', () => {
  it('keeps a long single-line result bounded', async () => {
    const target = document.createElement('div');
    const component = mount(ToolCall, {
      target,
      props: {
        content: {
          type: 'tool_result',
          toolName: 'codemode',
          toolCallId: 'codemode-result-1',
          result: 'A'.repeat(10_000),
        },
      },
    });
    destroy = () => unmount(component);

    target.querySelector<HTMLButtonElement>('.tool-header')?.click();
    await tick();

    expect(target.querySelector('pre.bounded-output-text')?.classList.contains('scrollable')).toBe(true);
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])('renders live read output for %s', async (mimeType) => {
    const target = document.createElement('div');
    const note = `Read image file [${mimeType}]`;
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'read', toolCallId: 'read-live', args: { path: 'image' } },
        result: note,
        data: { type: 'image', data: 'AQIDBA==', mimeType, note },
      },
    });
    destroy = () => unmount(component);
    await tick();

    expect(target.querySelector<HTMLImageElement>('.tool-content img')?.getAttribute('src')).toBe(`data:${mimeType};base64,AQIDBA==`);
    expect(target.querySelector('.tool-image-caption')?.textContent).toContain(note);
  });

  it('renders replayed read images from the tool result projection', async () => {
    const target = document.createElement('div');
    const note = 'Read image file [image/png]';
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'read', toolCallId: 'read-replay', args: { path: 'image' } },
        result: note,
        images: [{ data: 'AQIDBA==', mimeType: 'image/png' }],
      },
    });
    destroy = () => unmount(component);
    await tick();

    expect(target.querySelector<HTMLImageElement>('.tool-content img')?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==');
    expect(target.querySelector('.tool-image-caption')?.textContent).toContain(note);
  });
});
