<!-- Mobile counterpart of the desktop-only StatusBar — stat displays changed there likely need a twin change here. -->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ModelPicker from './ModelPicker.svelte';
  import ThinkingPicker from './ThinkingPicker.svelte';
  import CallButton from './CallButton.svelte';
  import { serverCapabilities } from '$lib/stores/server-capabilities.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import { tick } from 'svelte';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import { updateStore } from '$lib/stores/update.svelte.js';
  import { getContextDisplay, getContextTone } from '$lib/session-summary.js';
  import CostBreakdownPopover from './CostBreakdownPopover.svelte';
  import CopyButton from './CopyButton.svelte';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import X from '@lucide/svelte/icons/x';

  let open = $state(false);

  let session = $derived(sessionRegistry.viewedConversation);
  let child = $derived(sessionRegistry.viewedSubagentAttachment);
  let childNode = $derived.by(() => {
    const rootId = sessionRegistry.viewedSessionId;
    const path = rootId ? sessionRegistry.getSelectedSubagentPath?.(rootId) : null;
    return rootId && path ? sessionRegistry.getSubagentNode?.(rootId, path) : null;
  });
  let contextPercent = $derived(session?.contextUsage?.percent);
  let contextDisplay = $derived(getContextDisplay(session));
  let contextTone = $derived(getContextTone(contextPercent));

  let connectionLabel = $derived(connection.phaseLabel);

  /** The pi session behind the shown surface: the child when one is open. */
  let sessionIdentity = $derived(session ? { id: session.sessionId, file: session.sessionFile } : null);

  async function openFolderInstructions(): Promise<void> {
    const folderPath = session?.folderPath;
    if (!folderPath) return;
    open = false;
    await tick();
    await fileEditorStore.openFolderInstructions(folderPath);
  }

  let connectionDotClass = $derived(
    connection.phase === 'ready'
      ? 'bg-status-connected'
      : connection.phase === 'syncing'
        ? 'bg-status-active'
        : connection.phase === 'backoff' || connection.phase === 'connecting'
          ? 'bg-status-reconnecting'
          : 'bg-status-error',
  );

  let contextChipClass = $derived(
    contextTone === 'critical'
      ? 'border-status-error/20 bg-status-error/10 text-status-error'
      : contextTone === 'warning'
        ? 'border-warning/20 bg-warning/10 text-warning-foreground'
        : 'border-border bg-muted text-muted-foreground',
  );
</script>

{#snippet identityRow(label: string, value: string)}
  <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
    <span class="text-muted-foreground shrink-0">{label}</span>
    <div class="flex min-w-0 items-start justify-end gap-2">
      <span class="min-w-0 text-right font-mono text-xs break-all select-all" title={value}>{value}</span>
      <div class="shrink-0">
        <CopyButton text={value} title={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  </div>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-foreground max-md:size-11" title="Session details">
        <SlidersHorizontal class="size-4" />
        <span class="sr-only">Open session details</span>
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content
    showCloseButton={false}
    class="top-auto right-0 bottom-0 left-0 grid max-h-[85dvh] max-w-none translate-x-0 translate-y-0 gap-0 rounded-t-2xl rounded-b-none p-0 sm:top-1/2 sm:left-1/2 sm:max-h-none sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:gap-4 sm:rounded-xl sm:p-4"
  >
    <div class="border-border flex items-center justify-between border-b px-4 py-3 sm:hidden">
      <div class="text-sm font-semibold">{child ? 'Child details' : 'Session details'}</div>
      <Button variant="ghost" size="icon-sm" class="max-md:size-11" onclick={() => (open = false)} title="Close session details">
        <X class="size-4" />
        <span class="sr-only">Close session details</span>
      </Button>
    </div>

    <div class="hidden sm:block">
      <Dialog.Header>
        <Dialog.Title>{child ? 'Child details' : 'Session details'}</Dialog.Title>
      </Dialog.Header>
    </div>

    <div class="overflow-y-auto px-4 py-4 sm:px-0 sm:py-0">
      {#if child && childNode}
        <div class="bg-muted/50 mb-3 rounded-lg border px-3 py-2">
          <div class="text-muted-foreground text-[11px]">Child view</div>
          <div class="mt-0.5 truncate font-mono text-xs">{childNode.path.join('/')}</div>
        </div>
      {/if}
      <div class="rounded-xl border text-sm">
        <div class="flex items-center justify-between gap-3 px-3 py-3">
          <span class="text-muted-foreground">Model</span>
          <ModelPicker />
        </div>

        <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
          <span class="text-muted-foreground">Thinking</span>
          <ThinkingPicker />
        </div>

        {#if !child && serverCapabilities.voice}
          <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Voice call</span>
            <CallButton sessionId={session?.sessionId} variant="dialog-row" onAction={() => (open = false)} />
          </div>
        {/if}

        <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
          <span class="text-muted-foreground">Folder instructions</span>
          <Button
            variant="ghost"
            class="gap-1.5 max-md:min-h-11"
            disabled={connection.status !== 'connected' || !session?.folderPath || session.isRestoring || session.sessionId.startsWith('pending-')}
            onclick={() => void openFolderInstructions()}
          >
            <FilePen class="size-4" />
            Edit AGENTS.md
          </Button>
        </div>

        {#if contextDisplay}
          <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Context</span>
            <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium {contextChipClass}">
              {contextDisplay}
            </span>
          </div>
        {/if}

        {#if child}
          {#if childNode?.usage}<div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
              <span class="text-muted-foreground">Cost</span><span>${childNode.usage.cost.toFixed(2)}</span>
            </div>{/if}
        {:else if session}
          <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Cost</span>
            <CostBreakdownPopover totalCostUsd={session.lifetimeCostUsd} breakdown={session.usageBreakdown} contextLabel="Session" />
          </div>
        {/if}

        {#if session?.gitBranch}
          <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Git branch</span>
            <span class="max-w-[60%] min-w-0 truncate text-right font-medium">{session.gitBranch}</span>
          </div>
        {/if}

        {#if sessionIdentity}
          {@render identityRow('Session ID', sessionIdentity.id)}
          {#if sessionIdentity.file}
            {@render identityRow('Session file', sessionIdentity.file)}
          {/if}
        {/if}

        {#if session?.isStreaming || session?.isCompacting || session?.isNavigatingTree}
          <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Runtime</span>
            <div class="flex flex-wrap justify-end gap-1.5 text-xs">
              {#if session?.isStreaming}
                <span class="border-status-streaming/20 bg-status-streaming/10 text-status-streaming inline-flex items-center rounded-full border px-2 py-0.5 font-medium"
                  >Streaming</span
                >
              {/if}
              {#if session?.isCompacting}
                <span class="border-warning/20 bg-warning/10 text-warning-foreground inline-flex items-center rounded-full border px-2 py-0.5 font-medium">Compacting…</span>
              {/if}
              {#if session?.isNavigatingTree}
                <span class="border-status-active/20 bg-status-active/10 text-status-active inline-flex items-center rounded-full border px-2 py-0.5 font-medium"
                  >{session.treeNavigationSummarizing ? 'Summarizing…' : 'Navigating…'}</span
                >
              {/if}
            </div>
          </div>
        {/if}

        <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
          <span class="text-muted-foreground">Connection</span>
          <div class="flex items-center gap-2 font-medium">
            <span class="inline-flex size-2 rounded-full {connectionDotClass}"></span>
            <span>{connectionLabel}</span>
          </div>
        </div>

        {#if updateStore.showMarker}
          {@const updateStatus = updateStore.status}
          {#if updateStatus}
            <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
              <span class="text-muted-foreground">Pimote update</span>
              <div class="flex flex-col items-end gap-1 text-right text-xs">
                <span>Running {updateStatus.currentVersion}</span>
                <span>Available {updateStatus.latestVersion}</span>
                <!-- updateStatus.releaseUrl is a server-supplied external release URL, not a SPA route, so resolve() does not apply. -->
                <!-- eslint-disable svelte/no-navigation-without-resolve -->
                <a class="text-primary hover:text-primary/85 underline" href={updateStatus.releaseUrl} target="_blank" rel="noopener noreferrer">View release</a>
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
