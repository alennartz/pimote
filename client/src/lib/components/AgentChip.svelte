<script lang="ts">
  import type { AgentPath } from '@pimote/shared';
  import FolderNatureIcon from './FolderNatureIcon.svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';

  let {
    path,
    rootSessionId = '',
    name = undefined,
    persona = undefined,
    personaIcon = undefined,
  }: {
    path: AgentPath;
    rootSessionId?: string;
    name?: string;
    persona?: string;
    personaIcon?: string;
  } = $props();

  let node = $derived(rootSessionId && path.length > 0 ? sessionRegistry.getSubagentNode(rootSessionId, path) : null);
  let closedNode = $derived(rootSessionId && path.length > 0 ? sessionRegistry.getSubagentViewClosedNotice(rootSessionId, path)?.node : undefined);
  let displayName = $derived(name ?? path.at(-1) ?? 'root');
  let displayPersona = $derived(persona ?? node?.persona ?? closedNode?.persona);
  let displayPersonaIcon = $derived(personaIcon ?? node?.personaIcon ?? closedNode?.personaIcon);
  let displayState = $derived(node?.state);
  let label = $derived(displayPersona ? `${displayPersona}:${displayName}` : displayName);
  let fullPath = $derived(path.length > 0 ? path.join('/') : 'root');
</script>

<span
  class="agent-chip"
  data-agent-chip
  data-agent-state={displayState ?? 'unknown'}
  data-agent-path={fullPath}
  aria-label={`${label}${displayState ? `, ${displayState}` : ''}`}
  title={fullPath}
>
  {#if displayPersona}
    <span class="agent-chip-status agent-chip-persona" aria-hidden="true" data-persona-icon>
      {#if displayPersonaIcon}
        {displayPersonaIcon}
      {:else}
        <FolderNatureIcon kind="persona" class="size-3" />
      {/if}
    </span>
  {:else}
    <span class="agent-chip-status" aria-hidden="true"></span>
  {/if}
  {#if displayPersona}
    <span class="agent-chip-persona-name">{displayPersona}</span>
    <span class="agent-chip-separator" aria-hidden="true">:</span>
  {/if}
  <span class="agent-chip-name">{displayName}</span>
</span>

<style>
  .agent-chip {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    flex: none;
    align-items: center;
    gap: 0.2rem;
    padding: 0.08rem 0.5rem 0.08rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--foreground);
    font-size: 0.75rem;
    line-height: 1.4;
    white-space: nowrap;
  }

  .agent-chip-status {
    display: inline-flex;
    width: 0.48rem;
    height: 0.48rem;
    flex: none;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--muted-foreground);
    color: var(--muted-foreground);
  }

  .agent-chip-persona {
    width: auto;
    height: auto;
    border-radius: 0;
    background: transparent;
    font-size: 0.9rem;
  }

  .agent-chip[data-agent-state='running'] .agent-chip-status:not(.agent-chip-persona) {
    background: var(--status-connected);
  }

  .agent-chip[data-agent-state='waiting'] .agent-chip-status:not(.agent-chip-persona) {
    background: var(--status-reconnecting);
  }

  .agent-chip[data-agent-state='idle'] .agent-chip-status:not(.agent-chip-persona) {
    background: var(--custom-accent);
  }

  .agent-chip[data-agent-state='errored'] .agent-chip-status:not(.agent-chip-persona),
  .agent-chip[data-agent-state='dead'] .agent-chip-status:not(.agent-chip-persona) {
    background: var(--error-accent);
  }

  .agent-chip[data-agent-state='stopped'] .agent-chip-status:not(.agent-chip-persona) {
    border: 1px solid var(--muted-foreground);
    background: transparent;
  }

  .agent-chip[data-agent-state='running'] .agent-chip-persona {
    color: var(--status-connected);
  }

  .agent-chip[data-agent-state='waiting'] .agent-chip-persona {
    color: var(--status-reconnecting);
  }

  .agent-chip[data-agent-state='idle'] .agent-chip-persona {
    color: var(--custom-accent);
  }

  .agent-chip[data-agent-state='errored'] .agent-chip-persona,
  .agent-chip[data-agent-state='dead'] .agent-chip-persona {
    color: var(--error-accent);
  }

  .agent-chip-persona-name {
    overflow: hidden;
    color: var(--muted-foreground);
    text-overflow: ellipsis;
  }

  .agent-chip-separator {
    margin-inline: -0.15rem;
    color: var(--muted-foreground);
    opacity: 0.65;
  }

  .agent-chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
