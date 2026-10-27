// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ToolCall from './ToolCall.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('codemode tool results', () => {
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
});
