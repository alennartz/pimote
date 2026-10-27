// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ToolCall from './ToolCall.svelte';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('bash tool visualization', () => {
  it('renders the command as bash-highlighted code in the top section', async () => {
    const target = document.createElement('div');
    const component = mount(ToolCall, {
      target,
      props: {
        content: {
          type: 'tool_call',
          toolName: 'bash',
          toolCallId: 'bash-tool-1',
          args: { command: 'printf "hello\\n" && git status --short' },
        },
      },
    });
    destroy = () => unmount(component);

    target.querySelector<HTMLButtonElement>('button')?.click();
    await tick();

    const code = target.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(target.querySelector('button[aria-label="Copy command"]')).not.toBeNull();
    expect(code?.textContent).toBe('printf "hello\\n" && git status --short');
    expect(code?.innerHTML).toContain('hljs-');
  });
});
