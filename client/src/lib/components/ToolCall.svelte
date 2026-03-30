<script lang="ts">
  import type { PimoteMessageContent } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Wrench from '@lucide/svelte/icons/wrench';
  import CheckCircle from '@lucide/svelte/icons/check-circle-2';
  import Loader2 from '@lucide/svelte/icons/loader-2';

  let {
    content,
    inProgress = false,
    partialResult = '',
    result = undefined,
  }: {
    content: PimoteMessageContent;
    inProgress?: boolean;
    partialResult?: string;
    result?: unknown;
  } = $props();

  const MAX_COLLAPSED_LINES = 10;

  let expanded = $state(false);
  let argsExpanded = $state(false);
  let resultExpanded = $state(false);

  let toolName = $derived(content.toolName ?? 'unknown');
  let isResult = $derived(content.type === 'tool_result');
  let isCompleted = $derived(isResult || result !== undefined);

  const PATH_SEGMENT_THRESHOLD = 80;

  function shortenPath(fullPath: string, basePath: string): string {
    let display = fullPath;
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    if (base && display.startsWith(base + '/')) {
      display = display.slice(base.length + 1);
    }
    if (display.length > PATH_SEGMENT_THRESHOLD) {
      const segments = display.split('/');
      while (segments.length > 1 && segments.join('/').length > PATH_SEGMENT_THRESHOLD) {
        segments.shift();
      }
      display = '…/' + segments.join('/');
    }
    return display;
  }

  let toolDetail = $derived.by(() => {
    const args = content.args;
    if (!args || typeof args !== 'object') return '';
    const a = args as Record<string, unknown>;
    const name = toolName;
    if ((name === 'read' || name === 'write' || name === 'edit') && typeof a.path === 'string') {
      return shortenPath(a.path, sessionRegistry.viewed?.folderPath ?? '');
    }
    if (name === 'bash' && typeof a.command === 'string') {
      return a.command
        .replace(/[\n\r]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return '';
  });

  function formatData(data: unknown): string {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  let argsText = $derived(formatData(content.args));
  let argsLines = $derived(argsText.split('\n'));
  let argsNeedsCollapse = $derived(argsLines.length > MAX_COLLAPSED_LINES);
  let argsDisplayText = $derived(argsNeedsCollapse && !argsExpanded ? argsLines.slice(0, MAX_COLLAPSED_LINES).join('\n') : argsText);

  let resultText = $derived(isResult ? formatData(content.result) : result !== undefined ? formatData(result) : partialResult);
  let resultLines = $derived(resultText.split('\n'));
  let resultNeedsCollapse = $derived(resultLines.length > MAX_COLLAPSED_LINES);
  let resultDisplayText = $derived(resultNeedsCollapse && !resultExpanded ? resultLines.slice(0, MAX_COLLAPSED_LINES).join('\n') : resultText);
</script>

<div class="tool-block" class:tool-result={isResult} class:tool-completed={isCompleted} class:in-progress={inProgress}>
  <button class="tool-header" onclick={() => (expanded = !expanded)}>
    <ChevronRight class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}" size={14} />
    {#if inProgress}
      <Loader2 size={14} class="shrink-0 animate-spin" />
    {:else if isCompleted}
      <CheckCircle size={14} class="shrink-0" />
    {:else}
      <Wrench size={14} class="shrink-0" />
    {/if}
    <span class="tool-name">{toolName}</span>
    {#if toolDetail}
      <span class="tool-detail">{toolDetail}</span>
    {/if}
    {#if inProgress}
      <span class="tool-status">running…</span>
    {:else if isCompleted}
      <span class="tool-status">completed</span>
    {/if}
  </button>

  {#if expanded}
    <div class="tool-content">
      {#if argsText}
        <div class="tool-section">
          <div class="tool-section-label">Arguments</div>
          <pre class="tool-data" class:scrollable={argsExpanded}>{argsDisplayText}</pre>
          {#if argsNeedsCollapse}
            <button class="tool-toggle" onclick={() => (argsExpanded = !argsExpanded)}>
              {argsExpanded ? 'Show less' : `Show more… (${argsLines.length} lines)`}
            </button>
          {/if}
        </div>
      {/if}

      {#if inProgress && partialResult}
        <div class="tool-section">
          <div class="tool-section-label">Output (streaming)</div>
          <pre class="tool-data">{partialResult}</pre>
        </div>
      {:else if resultText}
        <div class="tool-section">
          <div class="tool-section-label">Result</div>
          <pre class="tool-data" class:scrollable={resultExpanded}>{resultDisplayText}</pre>
          {#if resultNeedsCollapse}
            <button class="tool-toggle" onclick={() => (resultExpanded = !resultExpanded)}>
              {resultExpanded ? 'Show less' : `Show more… (${resultLines.length} lines)`}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-block {
    margin: 0.25em 0;
    border-radius: 6px;
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: oklch(0.18 0.025 258);
    color: var(--muted-foreground);
    font-size: 0.8rem;
    cursor: pointer;
    border: none;
    text-align: left;
    transition: background-color 0.15s;
  }

  .tool-header:hover {
    background: oklch(0.22 0.03 258);
  }

  .tool-name {
    flex-shrink: 0;
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
    font-weight: 500;
    color: var(--foreground);
  }

  .tool-detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .tool-status {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 0.75rem;
    font-style: italic;
    opacity: 0.7;
  }

  .tool-content {
    border-top: 1px solid var(--border);
    background: oklch(0.15 0.02 258);
  }

  .tool-section {
    padding: 6px 12px;
  }

  .tool-section + .tool-section {
    border-top: 1px solid var(--border);
  }

  .tool-section-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted-foreground);
    margin-bottom: 4px;
    font-weight: 500;
  }

  .tool-data {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--foreground);
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  }

  .tool-data.scrollable {
    max-height: 400px;
    overflow-y: auto;
  }

  .tool-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: 0.8;
  }

  .tool-toggle:hover {
    opacity: 1;
    color: var(--foreground);
  }

  .in-progress .tool-header {
    background: oklch(0.18 0.035 258);
  }

  .tool-result .tool-header :global(svg),
  .tool-completed .tool-header :global(svg) {
    color: var(--status-connected, oklch(0.623 0.169 149.2));
  }
</style>
