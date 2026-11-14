<!-- Desktop-only (mounted under `hidden md:block`). Mobile shows these stats in SessionDetailsDialog. -->
<script lang="ts">
  import ModelPicker from './ModelPicker.svelte';
  import ThinkingPicker from './ThinkingPicker.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { updateStore } from '$lib/stores/update.svelte.js';
  import { getContextDisplay, getContextTone, getSessionDisplayName } from '$lib/session-summary.js';
  import CostBreakdownPopover from './CostBreakdownPopover.svelte';
  import { getRestoreModeLabel } from '$lib/restore-status.js';
  import { getAppName } from '$lib/branding.js';
  import { GitBranch, House } from '@lucide/svelte';
  import SessionRenameDialog from './SessionRenameDialog.svelte';
  import CallButton from './CallButton.svelte';
  import { serverCapabilities } from '$lib/stores/server-capabilities.svelte.js';
  import DownloadInbox from './DownloadInbox.svelte';
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import X from '@lucide/svelte/icons/x';
  import { createDelayedIndicator } from '$lib/navigation-indicator.svelte.js';

  const navigationIndicator = createDelayedIndicator(() => sessionRegistry.viewed?.isNavigatingTree ?? false);

  $effect(() => {
    navigationIndicator.update();
    return () => navigationIndicator.stop();
  });

  let restoreLabel = $derived(sessionRegistry.viewed?.isRestoring ? getRestoreModeLabel(sessionRegistry.viewed.restoreMode) : null);
  let connectionLabel = $derived(restoreLabel ?? connection.phaseLabel);

  let connectionColor = $derived(
    connection.phase === 'ready'
      ? 'bg-emerald-500'
      : connection.phase === 'syncing'
        ? 'bg-blue-500'
        : connection.phase === 'backoff' || connection.phase === 'connecting'
          ? 'bg-amber-500'
          : 'bg-red-500',
  );

  let activeChild = $derived(sessionRegistry.viewedSubagentAttachment);
  let activeNode = $derived.by(() => {
    const rootId = sessionRegistry.viewedSessionId;
    const path = rootId ? sessionRegistry.getSelectedSubagentPath?.(rootId) : null;
    return rootId && path ? sessionRegistry.getSubagentNode?.(rootId, path) : null;
  });
  let isChildSurface = $derived(Boolean(activeChild));
  let contextPercent = $derived(activeChild?.contextUsage?.percent ?? activeNode?.contextFill ?? sessionRegistry.viewed?.contextUsage?.percent);

  let contextDisplay = $derived(
    activeChild ? (contextPercent === null || contextPercent === undefined ? null : `${Math.round(contextPercent)}%`) : getContextDisplay(sessionRegistry.viewed),
  );

  let contextColor = $derived(
    getContextTone(contextPercent) === 'critical' ? 'text-red-400' : getContextTone(contextPercent) === 'warning' ? 'text-amber-400' : 'text-muted-foreground',
  );

  let sessionDisplayName = $derived(activeNode ? activeNode.path.join('/') : getSessionDisplayName(sessionRegistry.viewed));
  let hasHierarchy = $derived(Boolean(sessionRegistry.viewedSessionId && (sessionRegistry.subagentRoots?.[sessionRegistry.viewedSessionId]?.nodes.length ?? 0) > 0));

  async function closeChildSurface(): Promise<void> {
    const rootId = sessionRegistry.viewedSessionId;
    const path = rootId ? sessionRegistry.getSelectedSubagentPath?.(rootId) : null;
    if (!rootId || !path) return;
    await sessionRegistry.closeSubagentView?.(rootId, path);
    sessionRegistry.selectSubagentView?.(rootId, null);
  }
</script>

<div class="border-border bg-muted/30 text-muted-foreground shrink-0 border-b text-xs">
  <div class="flex h-9 items-center gap-1 px-2">
    <!-- Root navigation stays available on the root surface. Child views close
         explicitly and return to the root without changing the URL. -->
    {#if isChildSurface}
      <button
        class="text-muted-foreground hover:text-foreground hover:bg-accent flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        title="Close child view"
        aria-label="Close child view"
        onclick={() => void closeChildSurface()}
      >
        <X class="size-4" />
      </button>
    {:else}
      <button
        class="text-muted-foreground hover:text-foreground hover:bg-accent flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        title="Back to dashboard"
        aria-label="Back to dashboard"
        onclick={() => sessionRegistry.goHome()}
      >
        <House class="size-4" />
      </button>
    {/if}

    <Separator orientation="vertical" class="mx-0.5 h-4" />

    <!-- Model picker -->
    <ModelPicker />

    <Separator orientation="vertical" class="mx-0.5 h-4" />

    <!-- Thinking level picker -->
    <ThinkingPicker />

    {#if isChildSurface}
      <div class="text-muted-foreground min-w-0 flex-1 truncate text-xs">{sessionDisplayName}</div>
    {:else if !sessionDisplayName}
      <div class="flex-1"></div>
    {:else}
      <Separator orientation="vertical" class="mx-0.5 h-4" />
      <div class="flex min-w-0 flex-1">
        <SessionRenameDialog
          sessionId={sessionRegistry.viewed?.sessionId}
          folderPath={sessionRegistry.viewed?.folderPath}
          sessionName={sessionRegistry.viewed?.sessionName}
          displayName={sessionDisplayName}
        >
          {#snippet children({ openRenameDialog })}
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground min-w-0 flex-1 truncate text-left text-xs transition-colors select-none"
              title={`Rename session: ${sessionDisplayName}`}
              onclick={openRenameDialog}
            >
              {sessionDisplayName}
            </button>
          {/snippet}
        </SessionRenameDialog>
      </div>
    {/if}

    <!-- Context usage -->
    {#if contextDisplay}
      <span class="flex items-center gap-1 {contextColor}" title="Context window usage">
        {contextDisplay}
      </span>
    {/if}

    <!-- Session cost -->
    {#if isChildSurface}
      {#if activeNode?.usage}<span class="text-muted-foreground" title="Child cost">${activeNode.usage.cost.toFixed(2)}</span>{/if}
    {:else if sessionRegistry.viewed}
      <CostBreakdownPopover totalCostUsd={sessionRegistry.viewed.lifetimeCostUsd} breakdown={sessionRegistry.viewed.usageBreakdown} contextLabel="Session" />
    {/if}

    <!-- Git branch (root only) -->
    {#if !isChildSurface && sessionRegistry.viewed?.gitBranch}
      <span class="text-muted-foreground flex items-center gap-1" title="Git branch">
        <GitBranch class="size-3" />
        <span class="max-w-[8rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
      </span>

      <Separator orientation="vertical" class="mx-0.5 h-4" />
    {/if}

    {#if !isChildSurface && sessionRegistry.viewed?.downloads.length}
      <Separator orientation="vertical" class="mx-0.5 h-4" />
      <DownloadInbox />
    {/if}

    {#if !isChildSurface}
      <Button
        variant="ghost"
        size="xs"
        class="text-muted-foreground hover:text-foreground gap-1"
        title="Edit folder AGENTS.md"
        aria-label="Edit folder AGENTS.md"
        disabled={connection.status !== 'connected' ||
          !sessionRegistry.viewed?.folderPath ||
          sessionRegistry.viewed.isRestoring ||
          sessionRegistry.viewed.sessionId.startsWith('pending-')}
        onclick={() => void fileEditorStore.openFolderInstructions(sessionRegistry.viewed!.folderPath)}
      >
        <FilePen class="size-3" />
        AGENTS.md
      </Button>

      <!-- Voice call button (hidden when the server has voice disabled) -->
      {#if serverCapabilities.voice}
        <CallButton sessionId={sessionRegistry.viewed?.sessionId} />
      {/if}
    {/if}

    <!-- Streaming indicator -->
    {#if activeChild?.state.isStreaming || (!activeChild && sessionRegistry.viewed?.isStreaming)}
      <Badge variant="secondary" class="gap-1.5 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
        </span>
        Streaming
      </Badge>
    {/if}

    <!-- Compacting indicator -->
    {#if activeChild?.state.isCompacting || (!activeChild && sessionRegistry.viewed?.isCompacting)}
      <Badge variant="secondary" class="gap-1 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
        </span>
        Compacting…
      </Badge>
    {/if}

    <!-- Tree navigation indicator -->
    {#if navigationIndicator.visible}
      <Badge variant="secondary" class="gap-1 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-violet-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-violet-500"></span>
        </span>
        {sessionRegistry.viewed?.treeNavigationSummarizing ? 'Summarizing…' : 'Navigating…'}
      </Badge>
    {/if}

    {#if updateStore.showMarker}
      {@const updateStatus = updateStore.status}
      {#if updateStatus}
        <Separator orientation="vertical" class="mx-0.5 h-4" />
        <div class="flex items-center gap-1.5" title={`${getAppName()} update: running ${updateStatus.currentVersion}, available ${updateStatus.latestVersion}`}>
          <span>Running {updateStatus.currentVersion} → {updateStatus.latestVersion}</span>
          <!-- updateStatus.releaseUrl is a server-supplied external release URL, not a SPA route, so resolve() does not apply. -->
          <!-- eslint-disable svelte/no-navigation-without-resolve -->
          <a class="text-primary hover:text-primary/85 underline" href={updateStatus.releaseUrl} target="_blank" rel="noopener noreferrer">View release</a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        </div>
      {/if}
    {/if}

    <!-- Connection status -->
    <div class="flex items-center gap-1.5" title={connectionLabel}>
      <span class="relative flex size-2">
        {#if connection.phase === 'syncing' || connection.phase === 'connecting'}
          <span class="absolute inline-flex size-full animate-ping rounded-full {connectionColor} opacity-75"></span>
        {/if}
        <span class="relative inline-flex size-2 rounded-full {connectionColor}"></span>
      </span>
      <span class="text-xs">{connectionLabel}</span>
    </div>

    <!-- Hierarchy-first panel toggle -->
    {#if panelStore.hasCards || hasHierarchy}
      <Separator orientation="vertical" class="mx-0.5 h-4" />
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground hover:bg-accent relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        title={panelStore.isDrawer ? (panelStore.open ? 'Hide panels' : 'Show panels') : panelStore.collapsed ? 'Show panels' : 'Hide panels'}
        aria-label={panelStore.isDrawer ? (panelStore.open ? 'Hide panels' : 'Show panels') : panelStore.collapsed ? 'Show panels' : 'Hide panels'}
        aria-pressed={panelStore.isDrawer ? panelStore.open : !panelStore.collapsed}
        onclick={() => (panelStore.isDrawer ? panelStore.togglePanel() : panelStore.toggleCollapsed())}
      >
        <PanelRight class="size-4" />
        <span class="bg-primary text-primary-foreground absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-medium">
          {hasHierarchy ? (sessionRegistry.subagentRoots[sessionRegistry.viewedSessionId!]?.nodes.length ?? 0) : panelStore.cards.length}
        </span>
      </button>
    {/if}
  </div>
</div>
