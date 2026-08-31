// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import BashExecution, { type FinalBashExecutionMessage } from './BashExecution.svelte';
import type { BashExecutionState } from '$lib/stores/session-registry.svelte.js';

function runningExecution(overrides: Partial<BashExecutionState> = {}): BashExecutionState {
  return {
    id: 'bash-1',
    command: 'printf hello',
    excludeFromContext: false,
    output: 'hello\n',
    status: 'running',
    ...overrides,
  };
}

function render(execution: BashExecutionState | FinalBashExecutionMessage, onCancel?: () => void) {
  const target = document.createElement('div');
  const component = mount(BashExecution, { target, props: { execution, onCancel } });
  return { target, destroy: () => unmount(component) };
}

describe('BashExecution presentation contract', () => {
  it('renders a running shell command, its output, and an item-level cancel action', () => {
    const onCancel = vi.fn();
    const view = render(runningExecution(), onCancel);

    expect(view.target.textContent).toMatch(/\$\s+printf hello/);
    expect(view.target.textContent).toMatch(/hello/);
    expect(view.target.textContent).toMatch(/running/i);

    const cancel = Array.from(view.target.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Cancel');
    expect(cancel).toBeDefined();
    cancel!.click();
    expect(onCancel).toHaveBeenCalledOnce();

    view.destroy();
  });

  it('renders completed, nonzero, cancelled, and truncated native result states', () => {
    const completed = render({
      ...runningExecution({ status: 'complete' }),
      result: { output: 'done\n', exitCode: 0, cancelled: false, truncated: false },
    });
    expect(completed.target.textContent).toMatch(/complete/i);
    completed.destroy();

    const failedExecution = {
      role: 'bashExecution' as const,
      content: [{ type: 'text' as const, text: '$ false\nfailed' }],
      command: 'false',
      output: 'failed',
      exitCode: 1,
      cancelled: false,
      truncated: true,
      fullOutputPath: '/tmp/bash-output.log',
      excludeFromContext: false,
    };
    const failed = render(failedExecution);
    expect(failed.target.textContent).toMatch(/exit.*1/i);
    expect(failed.target.textContent).toMatch(/truncat/i);

    const excluded = render({ ...failedExecution, excludeFromContext: true });
    expect(excluded.target.querySelector('[data-testid="bash-execution"]')?.className).not.toBe(failed.target.querySelector('[data-testid="bash-execution"]')?.className);
    excluded.destroy();
    failed.destroy();

    const cancelled = render(
      runningExecution({
        status: 'cancelled',
        result: { output: '', cancelled: true, truncated: false },
      }),
    );
    expect(cancelled.target.textContent).toMatch(/cancelled/i);
    cancelled.destroy();

    const dispatchError = render(runningExecution({ status: 'error', error: 'WebSocket closed' }));
    expect(dispatchError.target.textContent).toContain('WebSocket closed');
    dispatchError.destroy();
  });

  it('keeps long output bounded until the user expands it', async () => {
    const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
    const view = render(runningExecution({ output, status: 'complete', result: { output, exitCode: 0, cancelled: false, truncated: false } }));

    const showMore = Array.from(view.target.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Show more');
    expect(showMore).toBeDefined();
    showMore!.click();
    await tick();
    expect(Array.from(view.target.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Show less')).toBe(true);

    view.destroy();
  });

  it('renders command output as text rather than executable markup', () => {
    const output = '<img src=x onerror="globalThis.compromised=true">';
    const view = render(runningExecution({ output }));

    expect(view.target.textContent).toContain(output);
    expect(view.target.querySelector('img')).toBeNull();

    view.destroy();
  });
});
