<script lang="ts">
  import FolderList from '$lib/components/FolderList.svelte';
  import MessageList from '$lib/components/MessageList.svelte';
  import InlineSelect from '$lib/components/InlineSelect.svelte';
  import PendingSteeringMessages from '$lib/components/PendingSteeringMessages.svelte';
  import InputBar from '$lib/components/InputBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import ActiveSessionBar from '$lib/components/ActiveSessionBar.svelte';
  import NotificationBanner from '$lib/components/NotificationBanner.svelte';
  import { sessionRegistry, confirmTakeover, dismissTakeover } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  function killConflicts() {
    const sessionId = sessionRegistry.viewedSessionId;
    const pids = sessionRegistry.viewed?.conflictingProcesses?.map((p) => p.pid) ?? [];
    if (!sessionId) return;
    connection
      .send({
        type: 'kill_conflicting_processes',
        sessionId,
        pids,
      })
      .catch(() => {});
    sessionRegistry.clearConflict(sessionId);
  }

  function dismissConflicts() {
    const sessionId = sessionRegistry.viewedSessionId;
    if (!sessionId) return;
    sessionRegistry.clearConflict(sessionId);
  }
</script>

<NotificationBanner />

{#if sessionRegistry.viewedSessionId}
  <!-- Active session view -->
  <div class="flex min-h-0 flex-1 flex-col">
    <StatusBar />
    {#if sessionRegistry.viewed?.pendingTakeover}
      <div class="bg-warning/10 border-warning/30 text-warning flex items-center gap-2 border-b px-4 py-2 text-sm">
        <span>This session is owned by another client. Take it over?</span>
        <button
          class="bg-warning text-warning-foreground hover:bg-warning/80 ml-auto rounded px-3 py-1 text-xs font-medium"
          onclick={() => confirmTakeover(sessionRegistry.viewedSessionId!)}
        >
          Take Over
        </button>
        <button class="border-warning/30 hover:bg-warning/20 rounded border px-3 py-1 text-xs font-medium" onclick={() => dismissTakeover(sessionRegistry.viewedSessionId!)}>
          Dismiss
        </button>
      </div>
    {/if}
    {#if sessionRegistry.viewed?.conflictingProcesses?.length}
      <div class="bg-destructive/10 border-destructive/30 text-destructive flex items-center gap-2 border-b px-4 py-2 text-sm">
        <span>External pi processes detected in this project.</span>
        <button class="bg-destructive text-primary-foreground hover:bg-destructive/80 ml-auto rounded px-3 py-1 text-xs font-medium" onclick={killConflicts}>
          Kill & Continue
        </button>
        <button class="border-destructive/30 hover:bg-destructive/20 rounded border px-3 py-1 text-xs font-medium" onclick={dismissConflicts}> Dismiss </button>
      </div>
    {/if}
    <MessageList />
    <InlineSelect />
    <PendingSteeringMessages />
    <ActiveSessionBar />
    <InputBar />
  </div>
{:else}
  <!-- Landing / folder browser -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div class="my-auto flex flex-col items-center p-8">
      <img src="/pwa/icon-512.png" alt="Pimote" class="mb-6 size-32" />
      <h1 class="text-foreground mb-2 text-2xl font-bold">Pimote</h1>
      <p class="text-muted-foreground mb-8 text-sm">Select a folder and session from the sidebar to get started.</p>

      <!-- Show folder browser inline on mobile as well -->
      <div class="w-full max-w-md md:hidden">
        <FolderList />
      </div>

      <ActiveSessionBar />
    </div>
  </div>
{/if}
