// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ToolCall from './ToolCall.svelte';
import { ensureHljs } from '$lib/code-highlight.js';

let destroy: (() => void) | undefined;

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

async function mountWriteAndExpand(args: Record<string, string>) {
  await ensureHljs();
  const target = document.createElement('div');
  const component = mount(ToolCall, {
    target,
    props: {
      content: {
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'write-tool-1',
        args,
      },
    },
  });
  destroy = () => unmount(component);

  target.querySelector<HTMLButtonElement>('button')?.click();
  await tick();
  await tick();
  return target;
}

describe('write tool visualization', () => {
  it('renders the file body with syntax highlighting for a known extension', async () => {
    const target = await mountWriteAndExpand({
      path: 'src/util.py',
      content: 'def answer():\n    return 42',
    });

    const code = target.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('def answer():\n    return 42');
    expect(code?.innerHTML).toContain('hljs-');
    const copyButton = target.querySelector<HTMLButtonElement>('button[aria-label="Copy file contents"]');
    expect(copyButton).not.toBeNull();
  });

  it('renders markdown writes through the markdown body instead of a code element', async () => {
    const target = await mountWriteAndExpand({
      path: 'notes.md',
      content: '# Title',
    });

    expect(target.querySelector('pre > code')).toBeNull();
    expect(target.textContent).toContain('Title');
  });

  it('renders plain text for an unknown extension', async () => {
    const target = await mountWriteAndExpand({
      path: 'data.zzz',
      content: 'const x = 1;',
    });

    const code = target.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.innerHTML).not.toContain('hljs-');
    expect(code?.textContent).toBe('const x = 1;');
  });
});
