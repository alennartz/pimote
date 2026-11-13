<script lang="ts">
  import type { PimoteMessageContent, PimoteSubagentFinalData, PimoteSubagentStartData } from '@pimote/shared';

  let { content }: { content: Extract<PimoteMessageContent, { type: 'subagent' }> } = $props();

  function pathText(path: readonly string[]): string {
    return path.length > 0 ? path.join('/') : 'root';
  }

  function title(): string {
    switch (content.subagentKind) {
      case 'send':
        return 'Subagent send operation';
      case 'respond':
        return 'Subagent respond operation';
      case 'await':
        return 'Subagent await operation';
      default:
        return `Subagent ${content.subagentKind} operation`;
    }
  }

  function stateLabel(): string {
    if (content.subagentState === 'protocol_error') return 'protocol error';
    if (content.subagentState === 'active') {
      const data = content.data as PimoteSubagentStartData;
      return data.operation === 'send' ? data.phase : 'active';
    }
    return content.subagentState;
  }

  function bodyLines(): string[] {
    const data = content.data as PimoteSubagentStartData | PimoteSubagentFinalData;
    if (data.operation === 'protocol_error') return [data.message];
    if (data.operation === 'send') {
      return [
        `To: ${pathText(data.to)}`,
        data.request ? `Request: ${data.request}` : 'Ready to send.',
        data.response ? `Response: ${data.response}` : '',
        'error' in data && data.error ? `Error: ${data.error}` : '',
      ].filter(Boolean);
    }
    if (data.operation === 'respond') return [data.body, 'error' in data && data.error ? `Error: ${data.error}` : ''].filter(Boolean);
    if (data.operation === 'await') {
      const statuses = 'statuses' in data ? data.statuses : data.result.statuses;
      return statuses.map((status) => `${pathText(status.path)}: ${status.state}${status.output ? ` — ${status.output}` : ''}${status.error ? ` — ${status.error}` : ''}`);
    }
    if (data.operation === 'delegation') return data.children.map((child) => `${pathText(child.path)}: ${child.task}`);
    if (data.operation === 'completion') return [data.result.output ?? data.result.error ?? data.result.state];
    if (data.operation === 'interrupt')
      return [...data.result.interrupted, ...data.result.pending, ...data.result.failed].map((target) => `${pathText(target.path)}${target.error ? `: ${target.error}` : ''}`);
    if (data.operation === 'teardown') return data.result.affectedAgents.map((agent) => `${pathText(agent.path)}: ${agent.state}`);
    if (data.operation === 'resurrect') return data.result.affectedAgents.map((agent) => `${pathText(agent.path)}: ${agent.state}`);
    return [];
  }

  let lines = $derived(bodyLines());
  let label = $derived(title());
  let status = $derived(stateLabel());
</script>

<article class="subagent-content-card" aria-label={label} data-subagent-state={content.subagentState}>
  <header class="subagent-content-header">
    <strong>{label}</strong>
    <span class="subagent-content-state">{status}</span>
  </header>
  <div class="subagent-content-body">
    {#each lines as line (line)}
      <p>{line}</p>
    {/each}
  </div>
</article>

<style>
  .subagent-content-card {
    margin: 0.35rem 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-left: 3px solid var(--custom-accent);
    border-radius: 6px;
    background: color-mix(in oklch, var(--custom-surface) 50%, transparent);
    font-size: 0.82rem;
  }

  .subagent-content-card[data-subagent-state='complete'] {
    border-left-color: var(--status-connected);
  }

  .subagent-content-card[data-subagent-state='error'],
  .subagent-content-card[data-subagent-state='protocol_error'] {
    border-left-color: var(--error-accent);
  }

  .subagent-content-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.35rem 0.55rem;
    background: var(--surface-raised);
  }

  .subagent-content-state {
    color: var(--muted-foreground);
    text-transform: lowercase;
  }

  .subagent-content-body {
    padding: 0.45rem 0.65rem;
  }

  .subagent-content-body p {
    margin: 0.15rem 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
