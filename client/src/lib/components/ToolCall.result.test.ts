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

    expect(target.querySelector('.tool-content [data-state]')?.getAttribute('data-state')).toBe('capped');
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
    expect(target.querySelector('.tool-image-indicator')?.nextElementSibling).toBe(target.querySelector('.tool-name'));
    expect(target.querySelector('.tool-content')?.textContent?.trim()).toBe('');
    expect(target.querySelector('.tool-content .tool-section-label')).toBeNull();
    expect(target.querySelector('.tool-image-caption')).toBeNull();
  });

  it('renders a content-addressed read image from tool result data', async () => {
    const target = document.createElement('div');
    const url = `/i/${'a'.repeat(64)}`;
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'read', toolCallId: 'read-ref', args: { path: 'image' } },
        result: 'Read image file [image/png]',
        data: { type: 'image', url, mimeType: 'image/png' },
      },
    });
    destroy = () => unmount(component);
    await tick();
    expect(target.querySelector<HTMLImageElement>('.tool-content img')?.getAttribute('src')).toBe(url);
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
    expect(target.querySelector('.tool-image-indicator')?.nextElementSibling).toBe(target.querySelector('.tool-name'));
    expect(target.querySelector('.tool-content')?.textContent?.trim()).toBe('');
    expect(target.querySelector('.tool-content .tool-section-label')).toBeNull();
    expect(target.querySelector('.tool-image-caption')).toBeNull();
  });

  it('keeps arguments and result sections for text-only read calls', async () => {
    const target = document.createElement('div');
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'read', toolCallId: 'read-text', args: { path: 'notes.txt' } },
        result: 'Text file contents',
      },
    });
    destroy = () => unmount(component);

    target.querySelector<HTMLButtonElement>('.tool-header')?.click();
    await tick();

    expect(target.querySelector('.tool-content')?.textContent).toContain('Arguments');
    expect(target.querySelector('.tool-content')?.textContent).toContain('Result');
    expect(target.querySelector('.tool-image-indicator')).toBeNull();
  });

  it('opens a read result image in the full-screen viewer', async () => {
    const target = document.createElement('div');
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'read', toolCallId: 'read-viewer', args: { path: 'image.png' } },
        result: 'Read image file [image/png]',
        images: [{ data: 'AQIDBA==', mimeType: 'image/png' }],
      },
    });
    destroy = () => unmount(component);
    await tick();

    target.querySelector<HTMLButtonElement>('.tool-image-body [aria-label="Open image full screen"]')?.click();
    await tick();

    expect(target.querySelector('.image-viewer-overlay .image-viewer-image')?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==');
  });

  it('renders ANSI colors in agent bash results and escapes markup', async () => {
    const target = document.createElement('div');
    const result = '\u001b[31mred\u001b[0m <img src=x onerror=alert(1)>';
    const component = mount(ToolCall, {
      target,
      props: {
        content: { type: 'tool_call', toolName: 'bash', toolCallId: 'bash-ansi', args: { command: 'printf red' } },
        result,
      },
    });
    destroy = () => unmount(component);

    target.querySelector<HTMLButtonElement>('.tool-header')?.click();
    await tick();

    const pre = target.querySelector('.tool-content pre.bounded-output-text');
    expect(pre?.innerHTML).toContain('<span style="color:#A00">red</span>');
    expect(pre?.innerHTML).toContain('&lt;img src=x');
    expect(target.querySelector('.tool-content img')).toBeNull();
  });
});
