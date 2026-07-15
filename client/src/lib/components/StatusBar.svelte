<!-- Desktop-only (mounted under `hidden md:block`). Mobile shows these stats in SessionSettingsDialog. -->
<script lang="ts">
  import ModelPicker from './ModelPicker.svelte';
  import ThinkingPicker from './ThinkingPicker.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { getContextDisplay, getContextTone, getSessionDisplayName, formatCombinedCost } from '$lib/session-summary.js';
  import { getRestoreModeLabel } from '$lib/restore-status.js';
  import { GitBranch } from '@lucide/svelte';
  import SessionRenameDialog from './SessionRenameDialog.svelte';
  import CallButton from './CallButton.svelte';
  import DownloadInbox from './DownloadInbox.svelte';

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

  let contextPercent = $derived(sessionRegistry.viewed?.contextUsage?.percent);

  let contextDisplay = $derived(getContextDisplay(sessionRegistry.viewed));

  let costDisplay = $derived(formatCombinedCost(sessionRegistry.viewed?.lifetimeCostUsd ?? 0, sessionRegistry.viewed?.nextRoundtripCostUsd));

  let contextColor = $derived(
    getContextTone(contextPercent) === 'critical' ? 'text-red-400' : getContextTone(contextPercent) === 'warning' ? 'text-amber-400' : 'text-muted-foreground',
  );

  let sessionDisplayName = $derived(getSessionDisplayName(sessionRegistry.viewed));
</script>

<div class="border-border bg-muted/30 text-muted-foreground shrink-0 border-b text-xs">
  <div class="flex h-9 items-center gap-1 px-2">
    <!-- Model picker -->
    <ModelPicker />

    <Separator orientation="vertical" class="mx-0.5 h-4" />

    <!-- Thinking level picker -->
    <ThinkingPicker />

    {#if !sessionDisplayName}
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
    {#if costDisplay}
      <span class="text-muted-foreground flex items-center gap-1" title="Session cost (next round-trip lower bound)">
        {costDisplay}
      </span>
    {/if}

    <!-- Git branch -->
    {#if sessionRegistry.viewed?.gitBranch}
      <span class="text-muted-foreground flex items-center gap-1" title="Git branch">
        <GitBranch class="size-3" />
        <span class="max-w-[8rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
      </span>

      <Separator orientation="vertical" class="mx-0.5 h-4" />
    {/if}

    {#if sessionRegistry.viewed?.downloads.length}
      <Separator orientation="vertical" class="mx-0.5 h-4" />
      <DownloadInbox />
    {/if}

    <!-- Voice call button -->
    <CallButton sessionId={sessionRegistry.viewed?.sessionId} />

    <!-- Streaming indicator -->
    {#if sessionRegistry.viewed?.isStreaming}
      <Badge variant="secondary" class="gap-1.5 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
        </span>
        Streaming
      </Badge>
    {/if}

    <!-- Compacting indicator -->
    {#if sessionRegistry.viewed?.isCompacting}
      <Badge variant="secondary" class="gap-1 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
        </span>
        Compacting…
      </Badge>
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
  </div>
</div>
