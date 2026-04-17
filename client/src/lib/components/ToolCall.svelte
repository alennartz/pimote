<script lang="ts">
  import type { PimoteMessageContent } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import StreamingCollapsible from './StreamingCollapsible.svelte';
  import TextBlock from './TextBlock.svelte';
  import { buildEditDiffMarkdown, createEditDiffStreamer, type EditArgs } from '$lib/edit-diff.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Wrench from '@lucide/svelte/icons/wrench';
  import CheckCircle from '@lucide/svelte/icons/check-circle-2';
  import XCircle from '@lucide/svelte/icons/x-circle';
  import Loader2 from '@lucide/svelte/icons/loader-2';

  let {
    content,
    streaming = false,
    inProgress = false,
    partialResult = '',
    result = undefined,
    isError = false,
  }: {
    content: PimoteMessageContent;
    streaming?: boolean;
    inProgress?: boolean;
    partialResult?: string;
    result?: unknown;
    isError?: boolean;
  } = $props();

  let expanded = $state(false);

  let toolName = $derived(content.toolName ?? 'unknown');
  let isResult = $derived(content.type === 'tool_result');
  let isCompleted = $derived(isResult || result !== undefined);
  let isEdit = $derived(toolName === 'edit');

  // Streaming-diff state used only when isEdit.
  let streamer: ReturnType<typeof createEditDiffStreamer> | undefined = $state();
  let streamerWritten = 0;
  let streamingMarkdown = $state('');

  $effect(() => {
    if (!isEdit) return;
    if (!streaming) {
      // Cleanup when streaming transitions to false. We deliberately keep
      // `streamingMarkdown` around so the derived `editMarkdown` fallback
      // can cover any tick between `streaming` flipping off and
      // `content.args` being populated — otherwise the diff would briefly
      // blank out and the UI would fall through to the raw Arguments view.
      if (streamer) {
        streamer.dispose();
        streamer = undefined;
        streamerWritten = 0;
      }
      return;
    }
    const text = content.text ?? '';
    if (!text) return;
    if (!streamer) {
      streamer = createEditDiffStreamer();
      streamerWritten = 0;
    }
    if (text.length > streamerWritten) {
      streamer.write(text.slice(streamerWritten));
      streamerWritten = text.length;
    }
    streamingMarkdown = streamer.markdown;
  });

  $effect(() => {
    if (!isEdit) return;
    if (streaming || inProgress) {
      expanded = true;
    } else {
      expanded = false;
    }
  });

  let finalizedMarkdown = $derived(isEdit && content.args ? buildEditDiffMarkdown(content.args as EditArgs) : '');
  // Prefer the finalized view once args are available; fall back to the
  // last streamed markdown otherwise. This keeps the diff visible across
  // the streaming→finalized handoff even if `streaming` flips off one tick
  // before `content.args` arrives.
  let editMarkdown = $derived(isEdit ? finalizedMarkdown || streamingMarkdown : '');

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

  let argsText = $derived(streaming && !content.args ? (content.text ?? '') : formatData(content.args));
  let resultText = $derived(isResult ? formatData(content.result) : result !== undefined ? formatData(result) : partialResult);
</script>

<div class="tool-block" class:tool-result={isResult} class:tool-completed={isCompleted} class:tool-error={isError} class:in-progress={inProgress}>
  <button class="tool-header" onclick={() => (expanded = !expanded)}>
    <ChevronRight class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}" size={14} />
    {#if inProgress}
      <Loader2 size={14} class="shrink-0 animate-spin" />
    {:else if isCompleted && isError}
      <XCircle size={14} class="tool-icon-error shrink-0" />
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
      {#if isEdit && editMarkdown}
        <div class="tool-section">
          <TextBlock text={editMarkdown} streaming={streaming && !isCompleted} />
        </div>
      {:else if argsText}
        <div class="tool-section">
          <div class="tool-section-label">Arguments</div>
          <StreamingCollapsible text={argsText} streaming={streaming && !isCompleted} />
        </div>
      {/if}

      {#if resultText}
        <div class="tool-section">
          <div class="tool-section-label">{inProgress ? 'Output (streaming)' : 'Result'}</div>
          <StreamingCollapsible text={resultText} streaming={inProgress} />
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
    font-family: var(--font-mono);
    font-weight: 500;
    color: var(--foreground);
  }

  .tool-detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
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

  .in-progress .tool-header {
    background: oklch(0.18 0.035 258);
  }

  .tool-result:not(.tool-error) .tool-header :global(svg),
  .tool-completed:not(.tool-error) .tool-header :global(svg) {
    color: var(--status-connected, oklch(0.623 0.169 149.2));
  }

  .tool-result.tool-error .tool-header :global(svg),
  .tool-completed.tool-error .tool-header :global(svg) {
    color: var(--destructive, oklch(0.577 0.245 27.325));
  }
</style>
