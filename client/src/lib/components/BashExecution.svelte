<script lang="ts">
  import type { BashResult, PimoteAgentMessage } from '@pimote/shared';
  import type { BashExecutionState } from '$lib/stores/session-registry.svelte.js';

  const MAX_PREVIEW_LINES = 10;
  const MAX_PREVIEW_BYTES = 16 * 1024;
  const previewTextEncoder = new TextEncoder();

  function utf8ByteLength(value: string): number {
    return previewTextEncoder.encode(value).byteLength;
  }

  function truncateUtf8(value: string, maxBytes: number): string {
    if (maxBytes <= 0 || value.length === 0) return '';
    // Every UTF-16 code unit consumes at least one UTF-8 byte. Avoid encoding a
    // potentially enormous line just to discover that it exceeds the budget.
    if (value.length <= maxBytes && utf8ByteLength(value) <= maxBytes) return value;

    let low = 0;
    let high = Math.min(value.length, maxBytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    return value.slice(0, low);
  }

  /** Build a collapsed preview without splitting or rendering the whole output. */
  function buildPreview(value: string): { text: string; truncated: boolean } {
    if (!value) return { text: '', truncated: false };

    let cursor = 0;
    let lines = 0;
    let bytes = 0;
    while (cursor < value.length && lines < MAX_PREVIEW_LINES) {
      const newline = value.indexOf('\n', cursor);
      const lineEnd = newline === -1 ? value.length : newline + 1;
      const line = value.slice(cursor, lineEnd);
      const available = MAX_PREVIEW_BYTES - bytes;
      const lineBytes = line.length <= available ? utf8ByteLength(line) : available + 1;
      if (bytes + lineBytes > MAX_PREVIEW_BYTES) {
        const prefix = truncateUtf8(line, MAX_PREVIEW_BYTES - bytes);
        return { text: value.slice(0, cursor) + prefix, truncated: true };
      }
      bytes += lineBytes;
      cursor = lineEnd;
      lines++;
    }

    return { text: value.slice(0, cursor), truncated: cursor < value.length };
  }

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
  let expanded = $state(false);

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
  let preview = $derived(buildPreview(output));
  let needsExpansion = $derived(preview.truncated);
  let visibleOutput = $derived(expanded || !needsExpansion ? output : preview.text);
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

  {#if visibleOutput}
    <pre class="bash-output">{visibleOutput}</pre>
  {/if}

  {#if needsExpansion}
    <button type="button" class="bash-toggle" onclick={() => (expanded = !expanded)}>{expanded ? 'Show less' : 'Show more'}</button>
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
    border-left: 3px solid oklch(0.68 0.14 175);
    border-radius: 6px;
    background: oklch(0.2 0.03 175 / 0.52);
    padding: 8px 10px;
    color: var(--foreground);
    font-size: 0.85rem;
  }

  .bash-execution-excluded {
    border-left-color: var(--muted-foreground);
    background: oklch(0.2 0.02 260 / 0.35);
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
    font-size: 0.82rem;
    font-weight: 600;
  }

  .bash-output {
    margin: 6px 0 0;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .bash-status {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    color: var(--muted-foreground);
    font-size: 0.72rem;
  }

  .bash-cancel,
  .bash-toggle {
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
    color: oklch(0.78 0.12 30);
    font-weight: 600;
  }

  .bash-toggle {
    display: inline-block;
    margin-top: 5px;
    color: oklch(0.72 0.13 175);
  }
</style>
