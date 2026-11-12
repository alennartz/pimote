<script lang="ts">
  import { observeFullyOffscreen } from '$lib/auto-collapse.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { SemanticBlock, SemanticBlockAction, SemanticChildResult, SemanticDelegationChild } from '$lib/subagent-semantic.js';
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Hourglass from '@lucide/svelte/icons/hourglass';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Reply from '@lucide/svelte/icons/reply';
  import Square from '@lucide/svelte/icons/square';
  import X from '@lucide/svelte/icons/x';

  let {
    block,
    onAction,
    viewerPath = [],
  }: {
    block: SemanticBlock;
    viewerPath?: readonly string[];
    onAction?: (action: SemanticBlockAction) => void;
  } = $props();

  let expanded = $state(true);
  let rootEl: HTMLElement | undefined = $state();

  // Semantic blocks start open so a live event is readable. Once the block has
  // passed out of the transcript, collapse it like tool and thinking blocks.
  $effect(() => {
    if (!expanded || !rootEl) return;
    return observeFullyOffscreen(rootEl, () => {
      expanded = false;
    });
  });

  function pathText(path: readonly string[]): string {
    return path.length > 0 ? path.join('/') : 'root';
  }

  function samePath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index]);
  }

  function kindLabel(kind: SemanticBlock['kind']): string {
    switch (kind) {
      case 'delegation':
        return 'Delegation';
      case 'message_thread':
        return 'Message';
      case 'await_progress':
        return 'Progress';
      case 'completion':
        return 'Completion';
      case 'lifecycle':
        return 'Lifecycle';
    }
  }

  function usageText(result: SemanticChildResult): string {
    const parts: string[] = [];
    if (result.contextPercent !== undefined) parts.push(`${result.contextPercent}% context`);
    if (result.costUsd !== undefined) parts.push(`$${result.costUsd.toFixed(2)}`);
    return parts.join(' · ');
  }

  function childMetadata(child: SemanticDelegationChild): string {
    return [
      child.persona,
      child.state,
      child.contextPercent === undefined ? undefined : `${child.contextPercent}% context`,
      child.costUsd === undefined ? undefined : `$${child.costUsd.toFixed(2)}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' · ');
  }

  function resultDetail(result: SemanticChildResult): string {
    if (result.error) return `Error: ${result.error}`;
    if (result.output !== undefined) return `Output: ${result.output}`;
    return `State: ${result.state}`;
  }

  function actionLabel(action: SemanticBlockAction): string {
    switch (action.type) {
      case 'open_view':
        return 'Open view';
      case 'retry':
        return 'Retry';
      case 'resurrect':
        return 'Resurrect';
    }
  }

  function actionPath(action: SemanticBlockAction): string {
    return pathText(action.path);
  }

  function invokeAction(action: SemanticBlockAction): void {
    onAction?.(action);
  }

  function resultFailed(result: SemanticChildResult): boolean {
    return Boolean(result.error) || result.state === 'errored' || result.state === 'dead';
  }

  function blockStatus(): 'pending' | 'success' | 'error' | 'interrupted' | 'info' {
    if (block.kind === 'message_thread') return block.data.phase === 'failure' || block.data.failure !== undefined ? 'error' : 'info';
    if (block.kind === 'completion') return resultFailed(block.data.result) ? 'error' : block.data.result.state === 'stopped' ? 'interrupted' : 'success';
    if (block.kind === 'await_progress') {
      if (block.data.children.some(resultFailed)) return 'error';
      return block.data.phase === 'completed' ? 'success' : block.data.phase === 'interrupted' ? 'interrupted' : 'pending';
    }
    if (block.kind === 'delegation') {
      const results = block.data.results ?? [];
      if (results.some(resultFailed)) return 'error';
      return block.data.children.length > 0 && block.data.children.every((child) => results.some((result) => samePath(child.path, result.path))) ? 'success' : 'pending';
    }
    return block.data.outcome === 'failed' ? 'error' : 'info';
  }

  let status = $derived(blockStatus());

  function hasInlineOpenAction(action: SemanticBlockAction): boolean {
    if (action.type !== 'open_view') return false;
    if (block.kind === 'delegation') {
      return [...block.data.children, ...(block.data.results ?? [])].some((item) => samePath(item.path, action.path));
    }
    if (block.kind === 'await_progress') return block.data.children.some((child) => samePath(child.path, action.path));
    return false;
  }

  function hasFooterActions(): boolean {
    return block.actions.some((action) => !hasInlineOpenAction(action));
  }
</script>

<article
  bind:this={rootEl}
  class="subagent-semantic-block"
  class:failed={status === 'error'}
  data-semantic-kind={block.kind}
  data-semantic-status={status}
  data-block-id={block.blockId}
  aria-label={block.title}
>
  <button type="button" class="subagent-semantic-header" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
    <ChevronRight class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}" size={14} />
    {#if block.kind === 'delegation'}
      <ArrowUp class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'message_thread'}
      <ArrowLeftRight class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'await_progress' && status === 'success'}
      <Check class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'await_progress' && status === 'error'}
      <CircleAlert class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'await_progress'}
      <Hourglass class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'completion' && status === 'error'}
      <CircleAlert class="subagent-semantic-icon" size={14} />
    {:else if block.kind === 'completion'}
      <Check class="subagent-semantic-icon" size={14} />
    {:else if block.data.outcome === 'failed'}
      <CircleAlert class="subagent-semantic-icon" size={14} />
    {:else if block.data.operation === 'interrupt'}
      <Square class="subagent-semantic-icon" size={14} />
    {:else if block.data.operation === 'teardown'}
      <X class="subagent-semantic-icon" size={14} />
    {:else}
      <RefreshCw class="subagent-semantic-icon" size={14} />
    {/if}
    <span class="subagent-semantic-title">{block.title}</span>
    {#if block.kind === 'message_thread'}
      <span class="subagent-semantic-peer">{pathText(samePath(viewerPath, block.data.sourcePath) ? block.data.targetPath : block.data.sourcePath)}</span>
      {#if block.data.responseExpected !== undefined}
        <span
          class="subagent-response-cue"
          aria-label={block.data.responseExpected ? 'Response expected' : 'No response expected'}
          title={block.data.responseExpected ? 'Response expected' : 'No response expected'}
        >
          {#if block.data.responseExpected}<Reply size={14} aria-hidden="true" />{:else}<ArrowRight size={14} aria-hidden="true" />{/if}
        </span>
      {/if}
    {:else}
      <span class="subagent-semantic-kind">{kindLabel(block.kind)}</span>
    {/if}
  </button>

  {#if expanded}
    <div class="subagent-semantic-body">
      {#if block.kind === 'delegation'}
        <p class="subagent-semantic-summary">
          {block.data.children.length}
          {block.data.children.length === 1 ? 'child' : 'children'}{block.data.awaitsResult && status === 'pending' ? ' · waiting for results' : ''}
        </p>
        {#each block.data.children as child (JSON.stringify(child.path))}
          <div class="subagent-child-row">
            {#if child.personaIcon || child.persona}
              <span class="subagent-persona" aria-label={child.persona ?? 'role'}>{child.personaIcon ?? child.persona?.slice(0, 1)}</span>
            {/if}
            <div class="subagent-child-copy">
              <strong>{pathText(child.path)}</strong>
              <span class="subagent-detail subagent-prompt">{child.prompt}</span>
              {#if childMetadata(child)}<span class="subagent-metadata">{childMetadata(child)}</span>{/if}
              <div class="subagent-actions">
                <Button variant="outline" size="xs" class="max-md:min-h-11" onclick={() => invokeAction({ type: 'open_view', path: child.path })}>Open view</Button>
              </div>
            </div>
          </div>
        {/each}
        {#each block.data.results ?? [] as result (JSON.stringify(result.path))}
          <div class="subagent-result-row">
            <div class="subagent-child-copy">
              <strong>{pathText(result.path)}</strong>
              <span class:error={resultFailed(result)} class="subagent-detail">{resultDetail(result)}</span>
              {#if usageText(result)}<span class="subagent-metadata">{usageText(result)}</span>{/if}
              <div class="subagent-actions">
                <Button variant="outline" size="xs" class="max-md:min-h-11" onclick={() => invokeAction({ type: 'open_view', path: result.path })}>Open view</Button>
              </div>
            </div>
          </div>
        {/each}
      {:else if block.kind === 'message_thread'}
        <p class="subagent-thread subagent-detail">{block.data.request}</p>
        {#if block.data.reply !== undefined}<p class="subagent-thread subagent-detail"><strong>Reply</strong> {block.data.reply}</p>{/if}
        {#if block.data.failure !== undefined}<p class="subagent-thread subagent-detail error"><strong>Failure</strong> {block.data.failure}</p>{/if}
      {:else if block.kind === 'await_progress'}
        {#each block.data.children as child (JSON.stringify(child.path))}
          <div class="subagent-child-row">
            <span class="subagent-state-dot" data-state={child.state}></span>
            <div class="subagent-child-copy">
              <strong>{pathText(child.path)}</strong>
              <span class:error={child.state === 'errored' || child.state === 'dead'} class="subagent-metadata">{child.state}</span>
              {#if child.output}<span class="subagent-detail subagent-output">Output: {child.output}</span>{/if}
              {#if child.error}<span class="subagent-detail error">Error: {child.error}</span>{/if}
              {#if usageText(child)}<span class="subagent-metadata">{usageText(child)}</span>{/if}
              <div class="subagent-actions">
                <Button variant="outline" size="xs" class="max-md:min-h-11" onclick={() => invokeAction({ type: 'open_view', path: child.path })}>Open view</Button>
              </div>
            </div>
          </div>
        {/each}
        {#if block.data.interruption}
          <p class="subagent-note">Interrupted by {pathText(block.data.interruption.sourcePath)}: {block.data.interruption.text}</p>
        {/if}
      {:else if block.kind === 'completion'}
        <div class="subagent-route"><span>{pathText(block.data.result.path)}</span><span>{block.data.result.state}</span></div>
        <p class:error={resultFailed(block.data.result)} class="subagent-detail subagent-output">
          {resultDetail(block.data.result)}
        </p>
        {#if usageText(block.data.result)}<p class="subagent-metadata">{usageText(block.data.result)}</p>{/if}
      {:else}
        <p class:error={block.data.outcome === 'failed'} class="subagent-detail subagent-output">
          {block.data.outcome === 'succeeded' ? 'Succeeded' : 'Failed'}{block.data.output ? `: ${block.data.output}` : ''}{block.data.error ? `: ${block.data.error}` : ''}
        </p>
      {/if}

      {#if hasFooterActions()}
        <div class="subagent-actions">
          {#each block.actions as action (action.type + ':' + actionPath(action))}
            {#if !hasInlineOpenAction(action)}
              <Button variant="outline" size="xs" class="subagent-action max-md:min-h-11" onclick={() => invokeAction(action)}>
                {actionLabel(action)}{action.type === 'open_view' ? ` · ${actionPath(action)}` : ''}
              </Button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</article>

<style>
  .subagent-semantic-block {
    margin: 0.25em 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-left: 3px solid var(--custom-accent);
    border-radius: 6px;
    background: color-mix(in oklch, var(--custom-surface) 50%, transparent);
  }

  .subagent-semantic-block[data-semantic-status='success'] {
    border-left-color: var(--status-connected);
  }

  .subagent-semantic-block[data-semantic-status='interrupted'] {
    border-left-color: var(--warning);
  }

  .subagent-semantic-block[data-semantic-kind='lifecycle'] {
    border-left-color: var(--muted-foreground);
  }

  .subagent-semantic-block.failed {
    border-left-color: var(--error-accent);
  }

  .subagent-semantic-block[data-semantic-status='pending'] :global(.subagent-semantic-icon) {
    color: var(--muted-foreground);
  }

  .subagent-semantic-block[data-semantic-status='success'] :global(.subagent-semantic-icon) {
    color: var(--status-connected);
  }

  .subagent-semantic-block.failed :global(.subagent-semantic-icon),
  .subagent-semantic-block.failed .subagent-semantic-title {
    color: var(--error-foreground, var(--destructive));
  }

  .subagent-semantic-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    background: var(--surface-raised);
    color: var(--custom-foreground);
    font-size: 0.8rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .subagent-semantic-header:hover {
    background: var(--surface-hover);
  }

  .subagent-semantic-header:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  :global(.subagent-semantic-icon) {
    flex: 0 0 auto;
  }

  .subagent-semantic-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subagent-semantic-kind {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    font-weight: 400;
  }

  .subagent-semantic-peer {
    min-width: 0;
    max-width: 45%;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }

  .subagent-response-cue {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--muted-foreground);
  }

  .subagent-semantic-body {
    padding: 6px 12px;
    background: var(--surface-sunken);
    font-size: 0.8rem;
  }

  .subagent-semantic-summary,
  .subagent-note,
  .subagent-thread,
  .subagent-output,
  .subagent-metadata {
    margin: 0;
    line-height: 1.5;
  }

  .subagent-semantic-summary,
  .subagent-note,
  .subagent-metadata {
    color: var(--muted-foreground);
  }

  .subagent-route {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    color: var(--foreground);
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }

  .subagent-route span {
    min-width: 0;
    overflow-wrap: anywhere;
    padding: 2px 4px;
    border-radius: 4px;
    background: var(--surface-subtle);
  }

  .subagent-thread + .subagent-thread {
    margin-top: 6px;
  }

  .subagent-detail {
    display: block;
    max-height: 10rem;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .subagent-child-row,
  .subagent-result-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }

  .subagent-child-row:first-of-type {
    margin-top: 4px;
  }

  .subagent-persona {
    display: grid;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 1.25rem;
    place-items: center;
    border: 1px solid color-mix(in oklch, var(--custom-accent) 42%, var(--border));
    border-radius: 999px;
    color: var(--custom-foreground);
    font-size: 0.7rem;
  }

  .subagent-child-copy {
    min-width: 0;
    flex: 1;
  }

  .subagent-child-copy strong,
  .subagent-child-copy > span {
    display: block;
  }

  .subagent-child-copy strong {
    color: var(--foreground);
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }

  .subagent-prompt,
  .subagent-output {
    color: var(--muted-foreground);
  }

  .subagent-prompt {
    margin-top: 2px;
  }

  .subagent-metadata {
    max-width: 100%;
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
  }

  .subagent-state-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--muted-foreground);
  }

  .subagent-state-dot[data-state='running'] {
    background: var(--status-streaming, var(--success));
  }

  .subagent-state-dot[data-state='waiting'] {
    background: var(--status-warning, var(--warning));
  }

  .subagent-state-dot[data-state='errored'],
  .subagent-state-dot[data-state='dead'] {
    background: var(--status-error, var(--destructive));
  }

  .subagent-state-dot[data-state='stopped'] {
    background: var(--warning);
  }

  .subagent-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .subagent-thread.error,
  .subagent-detail.error,
  .subagent-output.error {
    color: var(--error-foreground, var(--destructive));
  }

  @media (max-width: 640px) {
    .subagent-child-row,
    .subagent-result-row {
      flex-wrap: wrap;
    }

    .subagent-route {
      flex-wrap: wrap;
    }
  }
</style>
