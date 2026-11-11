<script lang="ts">
  import type { SemanticBlock, SemanticBlockAction, SemanticChildResult, SemanticDelegationChild } from '$lib/subagent-semantic.js';

  let {
    block,
    onAction,
  }: {
    block: SemanticBlock;
    onAction?: (action: SemanticBlockAction) => void;
  } = $props();

  function pathText(path: readonly string[]): string {
    return path.length > 0 ? path.join('/') : 'root';
  }

  function stateText(state: string): string {
    return state;
  }

  function usageText(result: SemanticChildResult): string {
    const parts: string[] = [];
    if (result.usage) parts.push(`↑${result.usage.inputTokens} · ↓${result.usage.outputTokens}`);
    if (result.contextPercent !== undefined) parts.push(`ctx${result.contextPercent}%`);
    if (result.costUsd !== undefined) parts.push(`$${result.costUsd.toFixed(2)}`);
    return parts.join(' · ');
  }

  function childMetadata(child: SemanticDelegationChild): string {
    return [
      child.persona ? `persona ${child.persona}` : undefined,
      child.state ? stateText(child.state) : undefined,
      child.contextPercent === undefined ? undefined : `ctx${child.contextPercent}%`,
      child.costUsd === undefined ? undefined : `$${child.costUsd.toFixed(2)}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' · ');
  }

  function resultDetail(result: SemanticChildResult): string {
    if (result.error !== undefined) return `Error: ${result.error}`;
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
</script>

<article class="subagent-semantic-block semantic-card" data-semantic-kind={block.kind} data-block-id={block.blockId} aria-label={block.title}>
  <header class="subagent-semantic-header semantic-head">
    <span class="subagent-semantic-icon" aria-hidden="true">
      {#if block.kind === 'delegation'}↗{:else if block.kind === 'message_thread'}↔{:else if block.kind === 'await_progress'}⏳{:else if block.kind === 'completion'}✓{:else if block.data.outcome === 'failed'}!{:else if block.data.operation === 'interrupt'}■{:else if block.data.operation === 'teardown'}×{:else}↻{/if}
    </span>
    <strong>{block.title}</strong>
    <code>subagent.{block.kind}</code>
  </header>

  <div class="subagent-semantic-body semantic-body">
    {#if block.kind === 'delegation'}
      <p class="subagent-semantic-summary">
        {block.data.children.length}
        {block.data.children.length === 1 ? 'child' : 'children'}{block.data.awaitsResult ? ' · awaiting results' : ''}
      </p>
      {#each block.data.children as child (JSON.stringify(child.path))}
        <div class="subagent-child-row">
          {#if child.personaIcon || child.persona}
            <span class="subagent-persona" aria-label={child.persona ?? 'persona'}>{child.personaIcon ?? child.persona?.slice(0, 1)}</span>
          {/if}
          <div class="subagent-child-copy">
            <strong>{pathText(child.path)}</strong>
            <span class="subagent-prompt">Prompt: {child.prompt}</span>
            {#if childMetadata(child)}<span class="subagent-metadata">{childMetadata(child)}</span>{/if}
          </div>
          <button type="button" class="subagent-action" onclick={() => invokeAction({ type: 'open_view', path: child.path })}>Open view</button>
        </div>
      {/each}
      {#each block.data.results ?? [] as result (JSON.stringify(result.path))}
        <div class="subagent-result-row">
          <div class="subagent-child-copy">
            <strong>{pathText(result.path)}</strong>
            <span class:error={result.error !== undefined}>{resultDetail(result)}</span>
          </div>
          {#if usageText(result)}<span class="subagent-metadata">{usageText(result)}</span>{/if}
          <button type="button" class="subagent-action" onclick={() => invokeAction({ type: 'open_view', path: result.path })}>Open view</button>
        </div>
      {/each}
    {:else if block.kind === 'message_thread'}
      <div class="subagent-route route"><span>{pathText(block.data.sourcePath)}</span><span aria-hidden="true">→</span><span>{pathText(block.data.targetPath)}</span></div>
      <p class="subagent-thread"><strong>Request:</strong> {block.data.request}</p>
      {#if block.data.reply !== undefined}<p class="subagent-thread"><strong>Reply:</strong> {block.data.reply}</p>{/if}
      {#if block.data.failure !== undefined}<p class="subagent-thread subagent-error"><strong>Failure:</strong> {block.data.failure}</p>{/if}
    {:else if block.kind === 'await_progress'}
      {#each block.data.children as child (JSON.stringify(child.path))}
        <div class="subagent-child-row">
          <span class="subagent-state-dot" data-state={child.state}></span>
          <div class="subagent-child-copy">
            <strong>{pathText(child.path)}</strong>
            <span>{stateText(child.state)}</span>
            {#if child.output}<span class="subagent-output">Output: {child.output}</span>{/if}
            {#if child.error}<span class="subagent-error">Error: {child.error}</span>{/if}
          </div>
          {#if usageText(child)}<span class="subagent-metadata">{usageText(child)}</span>{/if}
          <button type="button" class="subagent-action" onclick={() => invokeAction({ type: 'open_view', path: child.path })}>Open view</button>
        </div>
      {/each}
      {#if block.data.interruption}
        <p class="subagent-note">Interrupted by {pathText(block.data.interruption.sourcePath)}: {block.data.interruption.text}</p>
      {/if}
    {:else if block.kind === 'completion'}
      <div class="subagent-route route"><span>{pathText(block.data.result.path)}</span><span>{stateText(block.data.result.state)}</span></div>
      <p class:error={block.data.result.error !== undefined} class="subagent-output">{resultDetail(block.data.result)}</p>
      {#if usageText(block.data.result)}<p class="subagent-metadata">{usageText(block.data.result)}</p>{/if}
    {:else}
      <p class:error={block.data.outcome === 'failed'} class="subagent-output">
        {block.data.outcome === 'succeeded' ? 'Succeeded' : 'Failed'}{block.data.output ? `: ${block.data.output}` : ''}{block.data.error ? `: ${block.data.error}` : ''}
      </p>
    {/if}

    {#if block.actions.length > 0}
      <div class="subagent-actions">
        {#each block.actions as action (action.type + ':' + actionPath(action))}
          <button type="button" class="subagent-action" onclick={() => invokeAction(action)}
            >{actionLabel(action)}{action.type === 'open_view' ? ` · ${actionPath(action)}` : ''}</button
          >
        {/each}
      </div>
    {/if}
  </div>
</article>

<style>
  .subagent-semantic-block {
    margin: 0.5rem 0 0.9rem;
    overflow: hidden;
    border: 1px solid color-mix(in oklch, var(--custom-accent) 48%, var(--border));
    border-radius: 0.65rem;
    background: color-mix(in oklch, var(--custom-surface) 82%, transparent);
  }

  .subagent-semantic-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid color-mix(in oklch, var(--custom-accent) 23%, var(--border));
    color: var(--custom-accent);
    font-size: 0.75rem;
  }

  .subagent-semantic-header code {
    margin-left: auto;
    color: var(--muted-foreground);
    font-family: var(--font-mono, monospace);
    font-size: 0.625rem;
    font-weight: 400;
  }

  .subagent-semantic-body {
    padding: 0.6rem 0.7rem;
    font-size: 0.75rem;
  }

  .subagent-semantic-summary,
  .subagent-note,
  .subagent-thread,
  .subagent-output,
  .subagent-metadata {
    margin: 0;
    line-height: 1.45;
  }

  .subagent-semantic-summary,
  .subagent-note,
  .subagent-metadata {
    color: var(--muted-foreground);
  }

  .subagent-route {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 0.45rem;
    color: var(--foreground);
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
  }

  .subagent-route span {
    padding: 0.2rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    background: var(--surface-raised);
  }

  .subagent-route span:nth-child(2) {
    padding: 0;
    border: 0;
    color: var(--custom-accent);
    background: transparent;
  }

  .subagent-thread + .subagent-thread {
    margin-top: 0.35rem;
  }

  .subagent-child-row,
  .subagent-result-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.45rem 0;
    border-top: 1px solid color-mix(in oklch, var(--custom-accent) 16%, var(--border));
  }

  .subagent-child-row:first-of-type {
    margin-top: 0.3rem;
  }

  .subagent-persona {
    display: grid;
    width: 1.15rem;
    height: 1.15rem;
    flex: 0 0 1.15rem;
    place-items: center;
    border: 1px solid color-mix(in oklch, var(--custom-accent) 42%, var(--border));
    border-radius: 0.3rem;
    color: var(--custom-accent);
    font-size: 0.65rem;
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
    font-size: 0.68rem;
  }

  .subagent-prompt,
  .subagent-output {
    overflow-wrap: anywhere;
    color: var(--muted-foreground);
  }

  .subagent-prompt {
    margin-top: 0.12rem;
  }

  .subagent-metadata {
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
  }

  .subagent-state-dot {
    width: 0.45rem;
    height: 0.45rem;
    flex: 0 0 0.45rem;
    border-radius: 50%;
    background: var(--muted-foreground);
  }

  .subagent-state-dot[data-state='running'] {
    background: var(--status-streaming, var(--success));
  }

  .subagent-state-dot[data-state='waiting'] {
    background: var(--status-warning, var(--warning));
  }

  .subagent-state-dot[data-state='errored'] {
    background: var(--status-error, var(--destructive));
  }

  .subagent-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.55rem;
  }

  .subagent-action {
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    padding: 0.25rem 0.4rem;
    color: var(--muted-foreground);
    background: transparent;
    font-size: 0.65rem;
  }

  .subagent-action:hover,
  .subagent-action:focus-visible {
    color: var(--foreground);
    background: var(--surface-hover);
  }

  .subagent-error,
  .subagent-output.error,
  .subagent-output.error {
    color: var(--error-foreground, var(--destructive));
  }
</style>
