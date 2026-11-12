<script lang="ts">
  import { onMount } from 'svelte';
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import { sessionRegistry, type SubagentViewClosedNotice } from '$lib/stores/session-registry.svelte.js';
  import { projectSubagentPanelRows, type AgentPath, type SubagentPanelState, type SubagentPanelRow, type SubagentTeardownConfirmation } from '$lib/subagent-view-state.js';
  import CardList from './CardList.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import Bot from '@lucide/svelte/icons/bot';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();
  let inspectedPath = $state<AgentPath | null>(null);
  let notice = $state<SubagentViewClosedNotice | null>(null);
  let teardownConfirmation = $state<SubagentTeardownConfirmation | null>(null);
  let resurrectOpen = $state(false);
  let resurrectSavedSessionId = $state('');
  let resurrectLocalId = $state('');
  let resurrectTask = $state('');
  let resurrectChannels = $state('');
  let resurrectModel = $state('');
  let busy = $state(false);

  const rootSessionId = $derived(sessionRegistry.viewedSessionId);
  const rootSession = $derived(rootSessionId ? sessionRegistry.sessions[rootSessionId] : null);
  const rootState = $derived(rootSessionId ? sessionRegistry.subagentRoots[rootSessionId] : null);
  const selectedPath = $derived(rootSessionId ? sessionRegistry.getSelectedSubagentPath(rootSessionId) : null);
  const selectedAttachment = $derived(rootSessionId && selectedPath ? sessionRegistry.getSubagentAttachment(rootSessionId, selectedPath) : null);
  const openChildPaths = $derived(
    rootState
      ? Object.values(rootState.attachments)
          .filter((attachment) => !attachment.closed)
          .map((attachment) => attachment.path)
      : [],
  );
  const panelState = $derived<SubagentPanelState>({
    inspectedPath,
    openChildPaths,
    selectedView: selectedPath
      ? { kind: 'child', path: selectedPath, incarnation: selectedAttachment?.incarnation, attachmentGeneration: selectedAttachment?.attachmentGeneration }
      : { kind: 'root' },
    panelPresentation: panelStore.presentation,
    panelOpen: panelStore.open,
    notice: notice ? { path: notice.path, reason: notice.reason === 'teardown' ? 'teardown' : 'unavailable' } : null,
    teardownConfirmation,
  });
  const rows = $derived(rootState ? projectSubagentPanelRows({ nodes: rootState.nodes }, panelState) : ([] as readonly SubagentPanelRow[]));
  const inspectedNode = $derived(rootState && inspectedPath ? (rootState.nodes.find((node) => samePath(node.path, inspectedPath)) ?? null) : null);
  const inspectorNode = $derived(inspectedNode ?? (selectedPath && rootState ? (rootState.nodes.find((node) => samePath(node.path, selectedPath)) ?? null) : null));
  const inspectorIsRoot = $derived(!inspectorNode);
  const openCount = $derived(openChildPaths.length);
  const hasHierarchy = $derived((rootState?.nodes.length ?? 0) > 0);

  function samePath(left: AgentPath | null | undefined, right: AgentPath | null | undefined): boolean {
    return !!left && !!right && left.length === right.length && left.every((part, index) => part === right[index]);
  }

  function pathLabel(path: AgentPath): string {
    return path.join('/');
  }

  function stateLabel(row: SubagentPanelRow): string {
    return row.metadata.activity ? `${row.metadata.state} · ${row.metadata.activity}` : row.metadata.state;
  }

  function costLabel(row: SubagentPanelRow): string {
    const usage = row.metadata.usage;
    if (!usage) return '';
    const cost = 'costUsd' in usage ? usage.costUsd : usage.cost;
    return `$${cost.toFixed(2)}`;
  }

  function contextLabel(row: SubagentPanelRow): string {
    const percent = row.metadata.contextPercent;
    return percent === undefined ? '' : `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }

  function inspect(path: AgentPath): void {
    inspectedPath = [...path];
    notice = null;
  }

  async function openView(path: AgentPath): Promise<void> {
    const rootId = rootSessionId;
    if (!rootId || path.length === 0) return;
    busy = true;
    if (panelStore.isDrawer) panelStore.closePanel();
    try {
      await sessionRegistry.openSubagentView(rootId, path);
    } finally {
      busy = false;
    }
  }

  function showView(path: AgentPath): void {
    const rootId = rootSessionId;
    if (!rootId) return;
    const attachment = sessionRegistry.getSubagentAttachment(rootId, path);
    if (attachment && !attachment.closed) {
      sessionRegistry.selectSubagentView(rootId, path);
      if (panelStore.isDrawer) panelStore.closePanel();
      return;
    }
    void openView(path);
  }

  async function closeChildView(): Promise<void> {
    const rootId = rootSessionId;
    const path = selectedPath;
    if (!rootId || !path) return;
    await sessionRegistry.closeSubagentView(rootId, path);
    sessionRegistry.selectSubagentView(rootId, null);
  }

  function requestTeardown(path: AgentPath): void {
    const rootId = rootSessionId;
    if (!rootId) return;
    const node = sessionRegistry.getSubagentNode(rootId, path);
    if (!node) return;
    const attachment = sessionRegistry.getSubagentAttachment(rootId, path);
    teardownConfirmation = {
      path: [...path],
      incarnation: node.incarnation,
      ...(attachment && !attachment.closed ? { attachmentGeneration: attachment.attachmentGeneration } : {}),
    };
  }

  async function confirmTeardown(): Promise<void> {
    const rootId = rootSessionId;
    const confirmation = teardownConfirmation;
    if (!rootId || !confirmation?.incarnation) return;
    busy = true;
    try {
      const response = await sessionRegistry.teardownSubagentView(rootId, confirmation.path, confirmation.incarnation, confirmation.attachmentGeneration);
      if (!response.success) notice = { rootSessionId: rootId, path: confirmation.path, reason: 'unavailable' };
      teardownConfirmation = null;
    } finally {
      busy = false;
    }
  }

  function cancelTeardown(): void {
    teardownConfirmation = null;
  }

  function prepareResurrection(closed: SubagentViewClosedNotice, open = true): void {
    const node = closed.node;
    const path = closed.path;
    resurrectSavedSessionId = node?.sessionId ?? selectedAttachment?.childSessionId ?? '';
    resurrectLocalId = path[path.length - 1] ?? '';
    resurrectTask = node?.task ?? '';
    resurrectChannels = (node?.channels ?? []).join(', ');
    resurrectModel = node?.model ?? '';
    if (open) resurrectOpen = true;
  }

  async function resurrect(): Promise<void> {
    const rootId = rootSessionId;
    if (!rootId || !resurrectSavedSessionId.trim() || !resurrectLocalId.trim() || !resurrectTask.trim()) return;
    busy = true;
    try {
      const response = await sessionRegistry.resurrectSubagent({
        rootSessionId: rootId,
        savedSessionId: resurrectSavedSessionId.trim(),
        parentPath: (notice?.path ?? []).slice(0, -1),
        localId: resurrectLocalId.trim(),
        task: resurrectTask.trim(),
        channels: resurrectChannels
          .split(',')
          .map((channel) => channel.trim())
          .filter(Boolean),
        ...(resurrectModel.trim() ? { model: resurrectModel.trim() } : {}),
      });
      if (response.success) {
        if (notice) sessionRegistry.clearPendingSubagentResurrection(notice.rootSessionId, notice.path);
        resurrectOpen = false;
        notice = null;
      }
    } finally {
      busy = false;
    }
  }

  function dismissNotice(): void {
    if (notice?.reason === 'teardown') sessionRegistry.clearPendingSubagentResurrection(notice.rootSessionId, notice.path);
    notice = null;
  }

  function cancelResurrection(): void {
    if (notice?.reason === 'teardown') sessionRegistry.clearPendingSubagentResurrection(notice.rootSessionId, notice.path);
    resurrectOpen = false;
  }

  onMount(() => {
    const pending = rootSessionId ? sessionRegistry.getPendingSubagentResurrection(rootSessionId) : null;
    const closed = rootSessionId ? sessionRegistry.getLatestSubagentClosedNotice(rootSessionId) : null;
    if (pending) {
      notice = pending;
      prepareResurrection(pending);
    } else if (closed) {
      notice = closed;
      prepareResurrection(closed, false);
    }
    const unsubscribe = sessionRegistry.onSubagentViewClosed((closed) => {
      if (closed.rootSessionId !== sessionRegistry.viewedSessionId) return;
      notice = closed;
      teardownConfirmation = null;
      if (closed.reason === 'teardown') prepareResurrection(closed, false);
    });
    const unsubscribeResurrection = sessionRegistry.onSubagentResurrectionRequested((requested) => {
      if (requested.rootSessionId !== sessionRegistry.viewedSessionId) return;
      notice = requested;
      teardownConfirmation = null;
      prepareResurrection(requested);
    });
    return () => {
      unsubscribe();
      unsubscribeResurrection();
    };
  });

  $effect(() => {
    const persisted = rootSessionId ? sessionRegistry.getLatestSubagentClosedNotice(rootSessionId) : null;
    if (persisted && !notice) {
      notice = persisted;
      prepareResurrection(persisted, false);
    }
  });

  $effect(() => {
    // A selected path can disappear in a topology snapshot before the close
    // event reaches the browser. Return to the root surface in that case.
    const rootId = rootSessionId;
    if (!rootId || !selectedPath || !rootState) return;
    if (!rootState.nodes.some((node) => samePath(node.path, selectedPath))) sessionRegistry.selectSubagentView(rootId, null);
  });
</script>

<div
  class="panel-host bg-sidebar text-sidebar-foreground border-sidebar-border flex min-h-0 w-72 max-w-[min(20rem,100%)] flex-1 flex-col overflow-hidden border-l"
  data-panel-host
  data-panel-presentation={panelStore.presentation}
>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
    <header class="flex items-center gap-2 px-2.5 py-2">
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-sm font-semibold">Panels</h2>
        <p class="text-muted-foreground text-xs">{hasHierarchy ? `${rootState?.nodes.length ?? 0} live` : 'Extensions'}</p>
      </div>
      {#if openCount > 0}<span class="text-muted-foreground text-xs">{openCount} open</span>{/if}
      {#if onClose}
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-foreground max-md:size-11" aria-label="Close panels" title="Close panels" onclick={onClose}>
          <X class="size-4" />
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground max-md:size-11"
          aria-label="Hide panels"
          title="Hide panels"
          onclick={() => (panelStore.isDrawer ? panelStore.closePanel() : panelStore.toggleCollapsed())}
        >
          <X class="size-4" />
        </Button>
      {/if}
    </header>

    {#if rootSession}
      <section class="border-sidebar-border/70 border-b px-2 pb-2" aria-label="Root session">
        <div class="border-sidebar-border bg-sidebar-accent/45 rounded-md border px-2.5 py-2">
          <div class="flex items-center gap-2">
            <span class="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-md">
              <Bot class="size-3.5" />
            </span>
            <div class="min-w-0 flex-1">
              <strong class="block truncate text-sm">{rootSession.sessionName || rootSession.projectName || 'Main session'}</strong>
              <span class="text-muted-foreground block truncate text-xs">{rootSession.isStreaming ? 'Running' : 'Root session'}</span>
            </div>
            <span class="text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px]">Root</span>
          </div>
        </div>
      </section>
    {/if}

    {#if hasHierarchy}
      <section class="hierarchy-section" aria-label="Subagent hierarchy">
        <div class="text-muted-foreground px-2 py-2 text-[10px] font-semibold tracking-wider uppercase">Hierarchy</div>
        <div class="space-y-0.5">
          {#each rows as row (pathLabel(row.path))}
            <div
              class="tree-row flex min-w-0 items-center gap-1 rounded-md border border-transparent py-0.5 pr-1 transition-colors {row.inspected
                ? 'border-ring/60 bg-sidebar-accent'
                : ''}"
              data-node={pathLabel(row.path)}
              style={`--tree-indent: ${Math.min(row.depth, 8) * 0.75}rem;`}
            >
              <button
                type="button"
                class="tree-row-select hover:bg-sidebar-accent/60 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 max-md:min-h-11 max-md:py-2.5"
                class:selected={row.inspected}
                aria-current={row.viewOpen && selectedPath && samePath(selectedPath, row.path) ? 'page' : undefined}
                aria-label={`Inspect ${pathLabel(row.path)}`}
                onclick={() => inspect(row.path)}
              >
                <ChevronRight class="tree-chevron text-muted-foreground size-3.5 shrink-0 transition-transform {row.depth === 0 ? 'rotate-90' : ''}" />
                <span class="status-dot shrink-0 {row.metadata.state}" aria-label={row.metadata.state}></span>
                {#if row.metadata.personaIcon}<span class="persona-icon">{row.metadata.personaIcon}</span>{/if}
                <span class="min-w-0 flex-1">
                  <strong class="block truncate text-xs">{row.label}</strong>
                  <span class="text-muted-foreground block truncate text-[11px]">{pathLabel(row.path)} · {stateLabel(row)}</span>
                </span>
              </button>
              <div class="tree-row-meta text-muted-foreground hidden shrink-0 items-center gap-1 font-mono text-[10px] max-md:hidden @[20rem]:flex">
                {#if contextLabel(row)}<span>{contextLabel(row)}</span>{/if}
                {#if costLabel(row)}<span>{costLabel(row)}</span>{/if}
              </div>
              <Button
                variant="ghost"
                size="xs"
                class={`open-action text-muted-foreground hover:text-foreground max-md:min-h-11 max-md:min-w-[4.5rem] max-md:justify-center ${row.viewOpen ? 'open bg-sidebar-accent text-foreground' : ''}`}
                data-open-node={pathLabel(row.path)}
                aria-label={row.viewOpen ? `Show ${pathLabel(row.path)} view` : `Open ${pathLabel(row.path)} view`}
                title={row.viewOpen ? 'Show open view' : 'Open child view'}
                disabled={busy}
                onclick={() => showView(row.path)}
              >
                <ExternalLink class="size-3.5" />
                <span class="hidden max-md:inline">{row.viewOpen ? 'View' : 'Open'}</span>
              </Button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <section class="agent-inspector border-sidebar-border/70 border-b px-2.5 py-3" aria-label="Selected subagent details">
      <div class="flex items-center gap-2">
        {#if inspectorNode?.personaIcon}<span class="persona-icon">{inspectorNode.personaIcon}</span>{/if}
        <strong class="min-w-0 flex-1 truncate font-mono text-xs"
          >{inspectorNode ? pathLabel(inspectorNode.path) : rootSession?.sessionName || rootSession?.projectName || 'Main session'}</strong
        >
        <span class="text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px]"
          >{inspectorIsRoot ? 'Root' : selectedPath && samePath(selectedPath, inspectorNode?.path) ? 'View open' : 'View closed'}</span
        >
      </div>
      <p class="text-muted-foreground mt-2 mb-3 text-xs leading-relaxed">
        {inspectorNode?.task ?? 'Select a child to inspect its details.'}
      </p>
      {#if inspectorNode}
        <div class="grid grid-cols-2 gap-x-3 gap-y-2">
          <div><span class="metadata-label">Persona</span><span>{inspectorNode.persona ?? 'Default'}</span></div>
          <div><span class="metadata-label">Model</span><span>{inspectorNode.model ?? '—'}{inspectorNode.thinkingLevel ? ` · ${inspectorNode.thinkingLevel}` : ''}</span></div>
          <div><span class="metadata-label">State</span><span>{inspectorNode.state}{inspectorNode.activity ? ` · ${inspectorNode.activity}` : ''}</span></div>
          <div><span class="metadata-label">Context</span><span>{inspectorNode.contextFill ?? '—'}{inspectorNode.contextFill !== undefined ? '%' : ''}</span></div>
          <div><span class="metadata-label">Cost</span><span>{inspectorNode.usage ? `$${inspectorNode.usage.cost.toFixed(2)}` : '—'}</span></div>
        </div>
        {#if inspectorNode.lastError}<p class="text-destructive mt-2 truncate text-xs">Error: {inspectorNode.lastError}</p>{:else if inspectorNode.lastOutput}<p
            class="text-muted-foreground mt-2 truncate text-xs"
          >
            Last output: {inspectorNode.lastOutput}
          </p>{/if}
        <div class="mt-3 flex flex-wrap gap-1.5">
          {#if selectedPath && samePath(selectedPath, inspectorNode.path)}
            <Button variant="outline" size="xs" class="max-md:min-h-11" onclick={() => void closeChildView()}>Close child view</Button>
          {:else}
            <Button variant="outline" size="xs" class="max-md:min-h-11" onclick={() => showView(inspectorNode.path)}
              >{rows.find((row) => samePath(row.path, inspectorNode?.path))?.viewOpen ? 'Show view' : 'Open view'}</Button
            >
          {/if}
          <Button variant="destructive" size="xs" class="max-md:min-h-11" onclick={() => requestTeardown(inspectorNode!.path)}>Teardown</Button>
        </div>
      {/if}
    </section>

    {#if panelStore.cards.length > 0}
      <section class="extension-panels pt-2" aria-label="Other panels">
        <div class="text-muted-foreground px-1 text-[10px] font-semibold tracking-wider uppercase">Other panels</div>
        <CardList cards={panelStore.cards} openInNewTab />
      </section>
    {/if}
  </div>

  {#if notice}
    <div class="border-warning/40 bg-warning/10 m-2 rounded-md border px-2.5 py-2 text-xs" role="status">
      <p><strong>{pathLabel(notice.path)}</strong> {notice.reason === 'teardown' ? 'was removed.' : 'is no longer available.'}</p>
      {#if notice.reason === 'teardown'}
        <Button variant="link" size="xs" class="text-foreground mt-1 h-auto px-0 underline" onclick={() => prepareResurrection(notice!)}>Resurrect saved session</Button>
      {/if}
      <Button variant="link" size="xs" class="text-muted-foreground ml-2 h-auto px-0 underline" onclick={dismissNotice}>Dismiss</Button>
    </div>
  {/if}
</div>

{#if teardownConfirmation}
  <div
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    role="presentation"
    onclick={(event) => event.currentTarget === event.target && cancelTeardown()}
  >
    <div class="bg-background max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-xl border p-4 shadow-xl" role="alertdialog" aria-modal="true" aria-labelledby="teardown-title">
      <h2 id="teardown-title" class="text-sm font-semibold">Teardown {pathLabel(teardownConfirmation.path)}?</h2>
      <p class="text-muted-foreground mt-2 text-xs leading-relaxed">This stops and removes the child from the live hierarchy. Its session file stays available for resurrection.</p>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" class="max-md:min-h-11" onclick={cancelTeardown}>Cancel</Button>
        <Button variant="destructive" size="sm" class="max-md:min-h-11" disabled={busy} onclick={() => void confirmTeardown()}>Teardown child</Button>
      </div>
    </div>
  </div>
{/if}

{#if resurrectOpen}
  <div
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    role="presentation"
    onclick={(event) => event.currentTarget === event.target && cancelResurrection()}
  >
    <div class="bg-background max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl border p-4 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="resurrect-title">
      <h2 id="resurrect-title" class="text-sm font-semibold">Resurrect child session</h2>
      <p class="text-muted-foreground mt-1 text-xs">Restore the saved conversation under its parent path.</p>
      <div class="mt-3 grid gap-2">
        <label class="field-label">Saved session ID<Input bind:value={resurrectSavedSessionId} aria-label="Saved session ID" /></label>
        <label class="field-label">Local ID<Input bind:value={resurrectLocalId} aria-label="Local ID" /></label>
        <label class="field-label">Task<textarea class="field-textarea" bind:value={resurrectTask} aria-label="Task"></textarea></label>
        <label class="field-label">Communication channels<Input bind:value={resurrectChannels} aria-label="Communication channels" placeholder="parent, scout" /></label>
        <label class="field-label">Model <span class="text-muted-foreground normal-case">(optional)</span><Input bind:value={resurrectModel} aria-label="Model" /></label>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" class="max-md:min-h-11" onclick={cancelResurrection}>Cancel</Button>
        <Button
          size="sm"
          class="max-md:min-h-11"
          disabled={busy || !resurrectSavedSessionId.trim() || !resurrectLocalId.trim() || !resurrectTask.trim()}
          onclick={() => void resurrect()}>Resurrect</Button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .panel-host {
    container-type: inline-size;
  }
  .status-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 999px;
    background: var(--muted-foreground);
  }
  .status-dot.running {
    background: var(--status-streaming);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--status-streaming) 14%, transparent);
  }
  .status-dot.waiting {
    background: var(--warning);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--warning) 14%, transparent);
  }
  .status-dot.errored {
    background: var(--destructive);
  }
  .status-dot.dead {
    background: var(--destructive);
  }
  .persona-icon {
    display: inline-grid;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in oklch, var(--custom-accent) 42%, var(--border));
    border-radius: 999px;
    color: var(--custom-foreground);
    font-size: 0.7rem;
  }
  .tree-row-select {
    padding-inline-start: calc(0.5rem + var(--tree-indent));
  }
  .tree-row-select.selected .tree-chevron {
    color: var(--foreground);
  }
  .tree-row-meta {
    line-height: 1.25;
  }
  .agent-inspector .metadata-label,
  .field-label {
    display: block;
    color: var(--muted-foreground);
    font-size: 0.65rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .agent-inspector .metadata-label + span {
    display: block;
    overflow: hidden;
    margin-top: 0.15rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .field-label :global([data-slot='input']),
  .field-textarea {
    display: block;
    width: 100%;
    margin-top: 0.25rem;
    text-transform: none;
    letter-spacing: normal;
  }
  .field-textarea {
    min-height: 5rem;
    resize: vertical;
    border: 1px solid var(--input);
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--foreground);
    padding: 0.4rem 0.625rem;
    font-size: 0.875rem;
    line-height: 1.4;
    outline: none;
  }
  .field-textarea:focus-visible {
    border-color: var(--ring);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 50%, transparent);
  }
  .panel-host[data-panel-presentation='drawer'] {
    height: 100%;
    padding-block-start: env(safe-area-inset-top);
    padding-block-end: env(safe-area-inset-bottom);
    border-left: 1px solid var(--border);
    box-shadow: -1rem 0 2.5rem color-mix(in oklch, black 40%, transparent);
  }
</style>
