<script lang="ts">
  import type { BashResult, PimoteAgentMessage } from '@pimote/shared';
  import type { BashExecutionState } from '$lib/stores/session-registry.svelte.js';
  import BoundedOutput from './BoundedOutput.svelte';

  /** Persisted native bash result accepted by the shared presentation boundary. */
  export type FinalBashExecutionMessage = PimoteAgentMessage & {
    role: 'bashExecution';
    command: string;
    output: string;
    cancelled: boolean;
    truncated: boolean;
  };

  export interface BashExecutionProps {
    execution: BashExecutionState | FinalBashExecutionMessage;
    onCancel?: () => void;
  }

  let { execution, onCancel }: BashExecutionProps = $props();

  function isTransientExecution(value: BashExecutionState | FinalBashExecutionMessage): value is BashExecutionState {
    return 'status' in value;
  }

  function messageText(message: FinalBashExecutionMessage): string {
    return message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n');
  }

  function commandFromMessage(message: FinalBashExecutionMessage): string {
    if (message.command) return message.command;
    const text = messageText(message);
    return text.startsWith('$ ') ? (text.slice(2).split('\n')[0] ?? '') : '';
  }

  function outputFromMessage(message: FinalBashExecutionMessage): string {
    if (message.output !== undefined) return message.output;
    const text = messageText(message);
    if (!text.startsWith('$ ')) return text;
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  }

  interface BashViewModel {
    transient: boolean;
    command: string;
    output: string;
    outputTruncated?: boolean;
    excludeFromContext: boolean;
    status: BashExecutionState['status'] | 'persisted';
    result?: BashResult;
    error?: string;
  }

  function normalizeExecution(value: BashExecutionState | FinalBashExecutionMessage): BashViewModel {
    if (isTransientExecution(value)) {
      return {
        transient: true,
        command: value.command,
        output: value.output,
        outputTruncated: value.outputTruncated,
        excludeFromContext: value.excludeFromContext,
        status: value.status,
        result: value.result,
        error: value.error,
      };
    }

    return {
      transient: false,
      command: commandFromMessage(value),
      output: outputFromMessage(value),
      excludeFromContext: value.excludeFromContext === true,
      status: 'persisted',
      result: {
        output: value.output,
        exitCode: value.exitCode,
        cancelled: value.cancelled,
        truncated: value.truncated,
        ...(value.fullOutputPath !== undefined ? { fullOutputPath: value.fullOutputPath } : {}),
      },
    };
  }

  let view = $derived(normalizeExecution(execution));
  let command = $derived(view.command);
  let output = $derived(view.output);
  let excludeFromContext = $derived(view.excludeFromContext);
  let result = $derived(view.result);
  let canCancel = $derived(view.transient && view.status === 'running' && onCancel !== undefined);
  let statusText = $derived.by(() => {
    if (view.status === 'error') return `error: ${view.error ?? 'dispatch failed'}`;
    if (view.status === 'running') return 'running';
    if (result?.cancelled || view.status === 'cancelled') return 'cancelled';
    if (result?.exitCode !== undefined && result.exitCode !== 0) return `exit ${result.exitCode}`;
    return 'complete';
  });
  let fullOutputPath = $derived(result?.fullOutputPath);
  let isTruncated = $derived(result?.truncated === true || view.outputTruncated === true);
</script>

<div data-testid="bash-execution" class="bash-execution {excludeFromContext ? 'bash-execution-excluded' : 'bash-execution-normal'}">
  <div class="bash-header">
    <code class="bash-command">$ {command}</code>
    {#if canCancel}
      <button type="button" class="bash-cancel" onclick={() => onCancel?.()}>Cancel</button>
    {/if}
  </div>

  {#if output}
    <div class="bash-output">
      <BoundedOutput text={output} bounded />
    </div>
  {/if}

  <div class="bash-status" aria-live="polite">
    <span>{statusText}</span>
    {#if isTruncated}
      <span>output truncated</span>
    {/if}
    {#if fullOutputPath}
      <span>full output: {fullOutputPath}</span>
    {/if}
  </div>
</div>

<style>
  .bash-execution {
    margin: 8px 0;
    border-left: 3px solid var(--bash-accent);
    border-radius: 6px;
    background: color-mix(in oklch, var(--skill-surface) 52%, transparent);
    padding: 8px 10px;
    color: var(--foreground);
    font-size: 0.85rem;
  }

  .bash-execution-excluded {
    border-left-color: var(--muted-foreground);
    background: color-mix(in oklch, var(--surface-subtle) 35%, transparent);
    color: var(--muted-foreground);
    opacity: 0.78;
  }

  .bash-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .bash-command {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, monospace);
    font-variant-ligatures: none;
    font-size: 0.82rem;
    font-weight: 600;
  }

  .bash-output {
    margin: 6px 0 0;
  }

  .bash-status {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    color: var(--muted-foreground);
    font-size: 0.72rem;
  }

  .bash-cancel {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.72rem;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .bash-cancel {
    flex-shrink: 0;
    color: color-mix(in oklch, var(--error-accent) 61%, white);
    font-weight: 600;
  }
</style>
