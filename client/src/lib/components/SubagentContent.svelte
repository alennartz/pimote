<script lang="ts">
  import type { AgentPath, PimoteMessageContent, SubagentUsage } from '@pimote/shared';
  import { formatTokenCount } from '$lib/session-summary.js';
  import { formatCacheHitRate } from '$lib/usage-summary.js';
  import { observeFullyOffscreen } from '$lib/auto-collapse.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import AgentChip from './AgentChip.svelte';
  import SubagentMarkdown from './SubagentMarkdown.svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleSlash from '@lucide/svelte/icons/circle-slash';
  import CheckCircle from '@lucide/svelte/icons/check-circle-2';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import XCircle from '@lucide/svelte/icons/x-circle';

  type SubagentContent = Extract<PimoteMessageContent, { type: 'subagent' }>;
  type AgentReference = Readonly<{
    path: AgentPath;
    persona?: string;
    personaIcon?: string;
  }>;

  let {
    content,
    rootSessionId = '',
    durationMs = undefined,
  }: {
    content: SubagentContent;
    rootSessionId?: string;
    durationMs?: number;
  } = $props();

  let expanded = $state(true);
  let rootEl: HTMLElement | undefined = $state();
  let startedAt = $state<number | undefined>();
  let measuredDurationMs = $state<number | undefined>();

  let active = $derived(content.subagentState === 'active');
  let title = $derived(titleFor(content));
  let status = $derived(statusFor(content));
  let references = $derived(referencesFor(content));
  let headerReferences = $derived(references.slice(0, 2));
  let extraReferenceCount = $derived(Math.max(0, references.length - headerReferences.length));
  let detail = $derived(detailFor(content));
  let effectiveDurationMs = $derived(content.durationMs ?? durationMs ?? measuredDurationMs);
  let durationText = $derived(effectiveDurationMs === undefined ? '' : ` · ${formatDuration(effectiveDurationMs)}`);
  let failed = $derived(isFailure(content));
  let aborted = $derived(content.subagentState === 'aborted' || (content.data.operation === 'await' && content.data.result.interrupted === true));

  $effect(() => {
    if (active) {
      if (startedAt === undefined) startedAt = performance.now();
      return;
    }
    if (startedAt !== undefined) {
      measuredDurationMs = Math.max(0, performance.now() - startedAt);
      startedAt = undefined;
    }
  });

  $effect(() => {
    if (active) {
      expanded = true;
      return;
    }
    if (!expanded || !rootEl) return;
    return observeFullyOffscreen(rootEl, () => {
      expanded = false;
    });
  });

  function titleFor(block: SubagentContent): string {
    if (block.subagentKind === 'delegation') return 'spawn';
    if (block.subagentKind === 'completion') return 'agent';
    if (block.subagentKind === 'message_received') return 'message';
    if (block.subagentKind === 'protocol_error' || block.data.operation === 'protocol_error') return 'protocol';
    return block.subagentKind;
  }

  function statusFor(block: SubagentContent): string {
    const data = block.data;
    if (block.subagentState === 'protocol_error' || data.operation === 'protocol_error') return 'protocol error';
    if (block.subagentState === 'active') {
      if (data.operation === 'send' && 'phase' in data.result) return `${data.result.phase}…`;
      if (data.operation === 'await') return 'waiting…';
      if (data.operation === 'delegation') return 'starting…';
      return 'running…';
    }
    if (block.subagentState === 'aborted') return data.operation === 'await' ? 'interrupted' : 'aborted';
    if (block.subagentState === 'error') return 'failed';
    if (data.operation === 'completion') return data.result.state;
    if (data.operation === 'delegation') return 'started';
    if (data.operation === 'interrupt') return data.result.failed.length > 0 ? 'partially failed' : 'completed';
    if (data.operation === 'teardown') {
      if (data.result.status === 'not_found') return 'not found';
      if (data.result.status === 'already_removed') return 'already removed';
      return 'removed';
    }
    if (data.operation === 'resurrect') return data.result.affectedAgents.some((agent) => agent.state === 'running') ? 'running' : 'restored';
    if (data.operation === 'await') return data.result.interrupted ? 'interrupted' : 'completed';
    if (data.operation === 'send') {
      if (resultBoolean(data.result, 'deferred')) return 'deferred';
      return resultText(data.result, 'response') ? 'replied' : 'sent';
    }
    if (data.operation === 'respond') return resultText(data.result, 'error') ? 'failed' : 'replied';
    return 'received';
  }

  function isFailure(block: SubagentContent): boolean {
    const data = block.data;
    if (block.subagentState === 'error' || block.subagentState === 'protocol_error' || data.operation === 'protocol_error') return true;
    if (data.operation === 'completion') return data.result.state === 'errored' || data.result.state === 'dead';
    if (data.operation === 'teardown') return data.result.status === 'not_found';
    if (data.operation === 'interrupt') return data.result.failed.length > 0;
    if (data.operation === 'await') return resultText(data.result, 'error') !== undefined;
    if (data.operation === 'send' || data.operation === 'respond') return resultText(data.result, 'error') !== undefined || resultBoolean(data.result, 'isError');
    return false;
  }

  function referencesFor(block: SubagentContent): AgentReference[] {
    const data = block.data;
    if (block.subagentKind === 'message_received' && data.operation === 'send') {
      const from = pathFrom(resultValue(data.result, 'from'));
      return from ? [{ path: from }] : [];
    }
    if (data.operation === 'delegation') {
      return data.result.children.map((child) => ({ path: child.path, ...(child.persona !== undefined ? { persona: child.persona } : {}) }));
    }
    if (data.operation === 'send') {
      const parameters = 'parameters' in data ? data.parameters : undefined;
      const path = pathFrom(parameters?.to) ?? pathFrom(resultValue(data.result, 'to'));
      return path ? [{ path }] : [];
    }
    if (data.operation === 'respond') return block.subagentPath && block.subagentPath.length > 0 ? [{ path: block.subagentPath }] : [];
    if (data.operation === 'await') {
      if (data.result.statuses.length > 0) return data.result.statuses.map(({ path }) => ({ path }));
      return pathsFrom(data.parameters.agents);
    }
    if (data.operation === 'completion') {
      return block.subagentPath && block.subagentPath.length > 0 ? [{ path: block.subagentPath }] : [];
    }
    if (data.operation === 'interrupt') {
      return [...data.result.interrupted.map(({ path }) => ({ path })), ...data.result.pending.map(({ path }) => ({ path })), ...data.result.failed.map(({ path }) => ({ path }))];
    }
    if (data.operation === 'teardown' || data.operation === 'resurrect') {
      return data.result.affectedAgents.map(({ path }) => ({ path }));
    }
    return [];
  }

  function detailFor(block: SubagentContent): string {
    const data = block.data;
    if (block.subagentKind === 'message_received' && data.operation === 'send') return resultText(data.result, 'message') ?? '';
    if (data.operation === 'delegation') return data.result.children[0]?.task ?? '';
    if (data.operation === 'send') {
      const parameters = 'parameters' in data ? data.parameters : undefined;
      return (typeof parameters?.message === 'string' ? parameters.message : resultText(data.result, 'request')) ?? resultText(data.result, 'response') ?? '';
    }
    if (data.operation === 'respond') {
      const parameters = 'parameters' in data ? data.parameters : undefined;
      return (typeof parameters?.message === 'string' ? parameters.message : undefined) ?? resultText(data.result, 'message') ?? '';
    }
    if (data.operation === 'completion') return data.result.error ?? data.result.output ?? '';
    if (data.operation === 'protocol_error') return data.result.error;
    if (data.operation === 'await') {
      if (data.result.error) return data.result.error;
      return data.result.statuses.length === 0 && pathsFrom(data.parameters.agents).length === 0 ? 'All agents' : '';
    }
    if (data.operation === 'interrupt')
      return `${data.result.interrupted.length} interrupted · ${data.result.pending.length} pending${data.result.failed.length > 0 ? ` · ${data.result.failed.length} failed` : ''}`;
    if (data.operation === 'teardown') return data.result.status === 'removed' ? '' : data.result.status.replace('_', ' ');
    if (data.operation === 'resurrect') return data.result.affectedAgents.length === 1 ? 'session restored' : `${data.result.affectedAgents.length} sessions restored`;
    return '';
  }

  function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function resultValue(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
  }

  function resultText(value: unknown, key: string): string | undefined {
    const result = resultValue(value, key);
    return typeof result === 'string' ? result : undefined;
  }

  function resultBoolean(value: unknown, key: string): boolean {
    return resultValue(value, key) === true;
  }

  function isAgentPath(value: unknown): value is AgentPath {
    return Array.isArray(value) && value.every((part) => typeof part === 'string');
  }

  function pathFrom(value: unknown): AgentPath | undefined {
    if (isAgentPath(value)) return value;
    if (typeof value === 'string') return value.length === 0 ? [] : value.split('/').filter(Boolean);
    if (isRecord(value)) return pathFrom(value.path ?? value.id);
    return undefined;
  }

  function pathsFrom(value: unknown): AgentReference[] {
    const path = pathFrom(value);
    if (path) return [{ path }];
    if (Array.isArray(value)) return value.flatMap(pathsFrom);
    return [];
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function usageLabel(usage: SubagentUsage): string {
    const cacheRate = formatCacheHitRate(usage);
    const cacheText = cacheRate ? ` · cache: ${cacheRate}` : '';
    return `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)}${cacheText} · $${usage.cost.toFixed(4)} · ${usage.turns} ${usage.turns === 1 ? 'turn' : 'turns'}`;
  }

  async function openAgentView(path: AgentPath): Promise<void> {
    if (!rootSessionId || path.length === 0) return;
    const attachment = sessionRegistry.getSubagentAttachment(rootSessionId, path);
    if (attachment && !attachment.closed) sessionRegistry.selectSubagentView(rootSessionId, path);
    else await sessionRegistry.openSubagentView(rootSessionId, path);
    if (panelStore.isDrawer) panelStore.closePanel();
  }
</script>

<article
  bind:this={rootEl}
  class="subagent-card"
  data-subagent-kind={content.subagentKind}
  data-subagent-state={content.subagentState}
  data-expanded={expanded}
  aria-label={`${title} subagent operation`}
>
  <button type="button" class="subagent-header" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
    <ChevronRight class="subagent-chevron {expanded ? 'rotated' : ''}" size={14} />
    {#if active}
      <Loader2 class="subagent-state-icon spinning" size={14} aria-label="Active" />
    {:else if aborted}
      <CircleSlash class="subagent-state-icon" size={14} aria-label="Interrupted" />
    {:else if failed}
      <XCircle class="subagent-state-icon failed" size={14} aria-label="Failed" />
    {:else}
      <CheckCircle class="subagent-state-icon succeeded" size={14} aria-label="Succeeded" />
    {/if}
    <span class="subagent-name">{title}</span>
    <span class="subagent-detail" title={detail.replace(/\s+/g, ' ').trim()}>
      {#each headerReferences as reference, index (`${reference.path.join('/')}:${index}`)}
        <AgentChip path={reference.path} {rootSessionId} persona={reference.persona} personaIcon={reference.personaIcon} />
      {/each}
      {#if extraReferenceCount > 0}<span class="subagent-more-agents">+{extraReferenceCount}</span>{/if}
      {#if detail}<span class="subagent-detail-text">{detail.replace(/\s+/g, ' ').trim()}</span>{/if}
    </span>
    <span class="subagent-status" class:active>{status}{durationText}</span>
  </button>

  {#if expanded}
    <div class="subagent-body">
      {#if content.data.operation === 'delegation'}
        {#each content.data.result.children as child (child.path.join('/'))}
          <div class="subagent-child">
            <div class="subagent-agent-row">
              <AgentChip path={child.path} {rootSessionId} persona={child.persona} />
              {#if rootSessionId && child.path.length > 0}
                <button
                  type="button"
                  class="subagent-view-button"
                  aria-label={`Open ${child.path.join('/')} view`}
                  title="Open agent view"
                  onclick={() => void openAgentView(child.path)}
                >
                  <ExternalLink size={12} />
                  <span>View</span>
                </button>
              {/if}
            </div>
            <SubagentMarkdown label="Task" text={child.task} streaming={active} />
          </div>
        {/each}
      {:else if content.subagentKind === 'message_received' && content.data.operation === 'send'}
        {@const from = pathFrom(resultValue(content.data.result, 'from'))}
        {@const to = pathFrom(resultValue(content.data.result, 'to'))}
        {#if from || to}
          <div class="subagent-agent-row subagent-message-route">
            {#if from}<span class="route-label">From</span><AgentChip path={from} {rootSessionId} />{/if}
            {#if to}<span class="route-label">To</span><AgentChip path={to} {rootSessionId} />{/if}
          </div>
        {/if}
        <SubagentMarkdown label="Message" text={resultText(content.data.result, 'message')} streaming={active} />
        {#if resultBoolean(content.data.result, 'responseExpected')}<div class="subagent-meta">Response expected</div>{/if}
      {:else if content.data.operation === 'send'}
        {@const parameters = 'parameters' in content.data ? content.data.parameters : undefined}
        <SubagentMarkdown label="Message" text={typeof parameters?.message === 'string' ? parameters.message : resultText(content.data.result, 'request')} streaming={active} />
        <SubagentMarkdown label="Response" text={resultText(content.data.result, 'response')} streaming={active && resultText(content.data.result, 'phase') === 'responding'} />
        <SubagentMarkdown label="Error" text={resultText(content.data.result, 'error')} />
      {:else if content.data.operation === 'respond'}
        {@const parameters = 'parameters' in content.data ? content.data.parameters : undefined}
        <SubagentMarkdown label="Reply" text={typeof parameters?.message === 'string' ? parameters.message : resultText(content.data.result, 'body')} streaming={active} />
        <SubagentMarkdown label="Result" text={resultText(content.data.result, 'message') ?? resultText(content.data.result, 'response')} />
        <SubagentMarkdown label="Error" text={resultText(content.data.result, 'error')} />
      {:else if content.data.operation === 'await'}
        {#if content.data.result.statuses.length > 0}
          {#each content.data.result.statuses as agent (agent.path.join('/'))}
            <div class="subagent-agent-block">
              <div class="subagent-agent-row"><AgentChip path={agent.path} {rootSessionId} /></div>
              <SubagentMarkdown label="Output" text={agent.output} streaming={active} />
              <SubagentMarkdown label="Error" text={agent.error} />
              {#if agent.sessionId}<div class="subagent-meta">Session {agent.sessionId}</div>{/if}
            </div>
          {/each}
        {:else}
          {@const requestedAgents = pathsFrom(content.data.parameters.agents)}
          {#each requestedAgents as agent (agent.path.join('/'))}
            <div class="subagent-agent-row"><AgentChip path={agent.path} {rootSessionId} /><span class="subagent-row-status">Waiting</span></div>
          {/each}
          {#if requestedAgents.length === 0}<div class="subagent-meta">Waiting for all agents</div>{/if}
        {/if}
        {#if content.data.result.error}<SubagentMarkdown label="Wait error" text={content.data.result.error} />{/if}
      {:else if content.data.operation === 'completion'}
        <SubagentMarkdown label="Output" text={content.data.result.output} />
        <SubagentMarkdown label="Error" text={content.data.result.error} />
        {#if content.data.result.usage}<div class="subagent-usage">{usageLabel(content.data.result.usage)}</div>{/if}
      {:else if content.data.operation === 'interrupt'}
        {#each content.data.result.interrupted as agent (agent.path.join('/'))}
          <div class="subagent-agent-block">
            <div class="subagent-agent-row"><AgentChip path={agent.path} {rootSessionId} /><span class="subagent-row-status">Interrupted</span></div>
            <SubagentMarkdown label="Output" text={agent.output} />
            <SubagentMarkdown label="Error" text={agent.error} />
          </div>
        {/each}
        {#each content.data.result.pending as agent (agent.path.join('/'))}
          <div class="subagent-agent-block">
            <div class="subagent-agent-row"><AgentChip path={agent.path} {rootSessionId} /><span class="subagent-row-status">Pending</span></div>
            <SubagentMarkdown label="Output" text={agent.output} />
          </div>
        {/each}
        {#each content.data.result.failed as agent (agent.path.join('/'))}
          <div class="subagent-agent-block">
            <div class="subagent-agent-row"><AgentChip path={agent.path} {rootSessionId} /><span class="subagent-row-status">Failed</span></div>
            <SubagentMarkdown label="Error" text={agent.error} />
          </div>
        {/each}
      {:else if content.data.operation === 'teardown'}
        {#each content.data.result.affectedAgents as agent (agent.path.join('/'))}
          <div class="subagent-agent-row subagent-lifecycle-row">
            <AgentChip path={agent.path} {rootSessionId} />
            <span class="subagent-usage">{usageLabel(agent.usage)}</span>
          </div>
        {/each}
      {:else if content.data.operation === 'resurrect'}
        {#each content.data.result.affectedAgents as agent (agent.path.join('/'))}
          <div class="subagent-agent-block">
            <div class="subagent-agent-row">
              <AgentChip path={agent.path} {rootSessionId} />
              {#if rootSessionId && agent.path.length > 0}
                <button
                  type="button"
                  class="subagent-view-button"
                  aria-label={`Open ${agent.path.join('/')} view`}
                  title="Open agent view"
                  onclick={() => void openAgentView(agent.path)}
                >
                  <ExternalLink size={12} />
                  <span>View</span>
                </button>
              {/if}
            </div>
            <div class="subagent-meta">Session {agent.sessionId}</div>
            <SubagentMarkdown label="Output" text={agent.output} />
            <SubagentMarkdown label="Error" text={agent.error} />
            <div class="subagent-usage">{usageLabel(agent.usage)}</div>
          </div>
        {/each}
      {:else if content.data.operation === 'protocol_error'}
        <SubagentMarkdown label="Error" text={content.data.result.error} />
      {/if}
    </div>
  {/if}
</article>

<style>
  .subagent-card {
    min-width: 0;
    margin: 0.25em 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.9rem;
  }

  .subagent-header {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: none;
    background: var(--surface-raised);
    color: var(--muted-foreground);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .subagent-header:hover {
    background: var(--surface-hover);
  }

  :global(.subagent-chevron) {
    flex: none;
    transition: transform 0.15s;
  }

  :global(.subagent-chevron.rotated) {
    transform: rotate(90deg);
  }

  :global(.subagent-state-icon) {
    flex: none;
  }

  :global(.subagent-state-icon.succeeded) {
    color: var(--status-connected);
  }

  :global(.subagent-state-icon.failed) {
    color: var(--error-accent);
  }

  :global(.subagent-state-icon.spinning) {
    animation: subagent-spin 1s linear infinite;
    color: var(--custom-accent);
  }

  @keyframes subagent-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .subagent-name {
    flex: none;
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    font-variant-ligatures: none;
    font-weight: 500;
  }

  .subagent-detail {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.35rem;
    overflow: hidden;
    font-size: 0.75rem;
  }

  .subagent-detail-text {
    min-width: 0;
    overflow: hidden;
    color: var(--muted-foreground);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subagent-more-agents {
    flex: none;
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .subagent-status {
    flex: none;
    margin-left: auto;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-style: italic;
    white-space: nowrap;
  }

  .subagent-status.active {
    color: var(--custom-foreground);
  }

  .subagent-body {
    min-width: 0;
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    background: var(--surface-sunken);
  }

  .subagent-child,
  .subagent-agent-block {
    min-width: 0;
    padding: 0.3rem 0;
  }

  .subagent-child + .subagent-child,
  .subagent-agent-block + .subagent-agent-block {
    margin-top: 0.45rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border);
  }

  .subagent-agent-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 0.35rem;
  }

  .subagent-message-route {
    flex-wrap: wrap;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .route-label,
  .subagent-row-status,
  .subagent-meta {
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .subagent-view-button {
    display: inline-flex;
    min-height: 1.5rem;
    flex: none;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    cursor: pointer;
  }

  .subagent-view-button:hover {
    border-color: var(--custom-accent);
    color: var(--foreground);
  }

  .subagent-usage {
    min-width: 0;
    margin-left: auto;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .subagent-lifecycle-row {
    margin: 0;
    padding: 0.3rem 0;
  }

  @media (max-width: 640px) {
    .subagent-header {
      gap: 5px;
      padding-inline: 8px;
    }

    .subagent-status {
      font-size: 0.7rem;
    }

    .subagent-lifecycle-row {
      flex-wrap: wrap;
    }

    .subagent-usage {
      width: 100%;
      margin-left: 1.2rem;
      text-align: left;
    }
  }
</style>
