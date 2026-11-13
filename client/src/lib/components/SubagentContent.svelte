<script lang="ts">
  import type { PimoteMessageContent } from '@pimote/shared';
  import SubagentData from './SubagentData.svelte';

  type SubagentContent = Extract<PimoteMessageContent, { type: 'subagent' }>;
  let { content }: { content: SubagentContent } = $props();

  function stateLabel(content: SubagentContent): string {
    if (content.subagentState === 'protocol_error') return 'protocol error';
    if (content.subagentState === 'active' && content.data.operation === 'send') return String(content.data.result.phase ?? 'active');
    return content.subagentState;
  }

  function parameterValues(content: SubagentContent): Readonly<Record<string, unknown>> | undefined {
    if (!('parameters' in content.data) || content.data.parameters === undefined) return undefined;
    const parameters = content.data.parameters;
    if (content.data.operation === 'await' && (parameters.agents === undefined || (Array.isArray(parameters.agents) && parameters.agents.length === 0))) {
      return { ...parameters, agents: 'All agents' };
    }
    return parameters;
  }

  let label = $derived(`Subagent ${content.subagentKind} operation`);
  let status = $derived(stateLabel(content));
  let parameters = $derived(parameterValues(content));
  let proseStreaming = $derived(content.subagentState === 'active' && (content.data.operation === 'send' || content.data.operation === 'respond'));
</script>

<article class="subagent-content-card" aria-label={label} data-subagent-state={content.subagentState}>
  <header class="subagent-content-header">
    <strong>{label}</strong>
    <span class="subagent-content-state">{status}</span>
  </header>
  <div class="subagent-content-body">
    {#key content.operationId}
      {#if parameters !== undefined}
        <section aria-label="Parameters">
          <h3>Parameters</h3>
          <SubagentData value={parameters} streaming={proseStreaming} />
        </section>
      {/if}
      <section aria-label="Result">
        <h3>Result</h3>
        <SubagentData value={content.data.result} streaming={proseStreaming} />
      </section>
    {/key}
  </div>
</article>

<style>
  .subagent-content-card {
    min-width: 0;
    margin: 0.35rem 0;
    border: 1px solid var(--border);
    border-left: 3px solid var(--custom-accent);
    border-radius: 6px;
    background: color-mix(in oklch, var(--custom-surface) 50%, transparent);
    font-size: 0.9rem;
    overflow-wrap: anywhere;
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
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
    padding: 0.4rem 0.65rem;
    border-radius: 4px 4px 0 0;
    background: var(--surface-raised);
    font-size: 0.75rem;
  }

  .subagent-content-state {
    color: var(--muted-foreground);
    text-transform: lowercase;
  }

  .subagent-content-body {
    min-width: 0;
    padding: 0.65rem;
  }

  section + section {
    margin-top: 0.85rem;
    padding-top: 0.65rem;
    border-top: 1px solid var(--border);
  }

  h3 {
    margin: 0 0 0.5rem;
    color: var(--custom-foreground);
    font-size: 0.75rem;
    font-weight: 600;
  }
</style>
