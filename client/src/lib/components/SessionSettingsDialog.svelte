<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ModelPicker from './ModelPicker.svelte';
  import ThinkingPicker from './ThinkingPicker.svelte';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { getContextDisplay, getContextTone } from '$lib/session-summary.js';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import X from '@lucide/svelte/icons/x';

  let open = $state(false);

  let session = $derived(sessionRegistry.viewed);
  let contextDisplay = $derived(getContextDisplay(session));
  let contextTone = $derived(getContextTone(session?.contextUsage?.percent));

  let connectionLabel = $derived(connection.phaseLabel);

  let connectionDotClass = $derived(
    connection.phase === 'ready'
      ? 'bg-emerald-500'
      : connection.phase === 'syncing'
        ? 'bg-blue-500'
        : connection.phase === 'backoff' || connection.phase === 'connecting'
          ? 'bg-amber-500'
          : 'bg-red-500',
  );

  let contextChipClass = $derived(
    contextTone === 'critical'
      ? 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
      : contextTone === 'warning'
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-border bg-muted text-muted-foreground',
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-foreground" title="Session settings">
        <SlidersHorizontal class="size-4" />
        <span class="sr-only">Open session settings</span>
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content
    showCloseButton={false}
    class="top-auto right-0 bottom-0 left-0 grid max-h-[85dvh] max-w-none translate-x-0 translate-y-0 gap-0 rounded-t-2xl rounded-b-none p-0 sm:top-1/2 sm:left-1/2 sm:max-h-none sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:gap-4 sm:rounded-xl sm:p-4"
  >
    <div class="border-border flex items-center justify-between border-b px-4 py-3 sm:hidden">
      <div class="text-sm font-semibold">Session settings</div>
      <Button variant="ghost" size="icon-sm" onclick={() => (open = false)} title="Close session settings">
        <X class="size-4" />
        <span class="sr-only">Close session settings</span>
      </Button>
    </div>

    <div class="hidden sm:block">
      <Dialog.Header>
        <Dialog.Title>Session settings</Dialog.Title>
      </Dialog.Header>
    </div>

    <div class="overflow-y-auto px-4 py-4 sm:px-0 sm:py-0">
      <div class="rounded-xl border text-sm">
        <div class="flex items-center justify-between gap-3 px-3 py-3">
          <span class="text-muted-foreground">Model</span>
          <ModelPicker />
        </div>

        <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
          <span class="text-muted-foreground">Thinking</span>
          <ThinkingPicker />
        </div>

        {#if contextDisplay}
          <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Context</span>
            <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium {contextChipClass}">
              {contextDisplay}
            </span>
          </div>
        {/if}

        {#if session?.gitBranch}
          <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Git branch</span>
            <span class="max-w-[60%] min-w-0 truncate text-right font-medium">{session.gitBranch}</span>
          </div>
        {/if}

        {#if session?.isStreaming || session?.isCompacting}
          <div class="border-border/60 flex items-start justify-between gap-3 border-t px-3 py-3">
            <span class="text-muted-foreground">Runtime</span>
            <div class="flex flex-wrap justify-end gap-1.5 text-xs">
              {#if session?.isStreaming}
                <span class="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400"
                  >Streaming</span
                >
              {/if}
              {#if session?.isCompacting}
                <span class="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                  >Compacting…</span
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
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
