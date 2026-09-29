<script lang="ts">
  import MessageList from '$lib/components/MessageList.svelte';
  import InlineSelect from '$lib/components/InlineSelect.svelte';
  import PendingSteeringMessages from '$lib/components/PendingSteeringMessages.svelte';
  import InputBar from '$lib/components/InputBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import MobileRuntimeStatus from '$lib/components/MobileRuntimeStatus.svelte';
  import ActiveSessionBar from '$lib/components/ActiveSessionBar.svelte';
  import CallingMode from '$lib/components/CallingMode.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { sessionRegistry, confirmTakeover, dismissTakeover } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { voiceCallStore } from '$lib/stores/voice-call-store.js';

  // The URL is the source of truth for which conversation is open (back/forward,
  // deep links, reloads). Adopt the route's session into the registry; stale ids
  // (closed sessions, superseded optimistic pending ids) follow the registry's
  // current view rather than bouncing home — the pending→real rekey can land
  // before this effect runs, leaving the URL one step behind.
  const routeSessionId = $derived(page.params.sessionId);

  $effect(() => {
    const id = routeSessionId;
    if (id === undefined) return; // required param — unreachable, satisfies types
    if (sessionRegistry.viewedSessionId === id) return;
    if (sessionRegistry.adoptRouteView(id)) {
      connection.send({ type: 'view_session', sessionId: id }).catch(() => {});
      return;
    }
    const current = sessionRegistry.viewedSessionId;
    if (current) {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic route param, base path is '/'
      void goto(`/sessions/${encodeURIComponent(current)}`, { replaceState: true });
    } else {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic route param, base path is '/'
      void goto('/', { replaceState: true });
    }
  });

  let inCall = $derived(voiceCallStore.state.phase !== 'idle' && voiceCallStore.state.sessionId === sessionRegistry.viewedSessionId);

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

{#if inCall}
  <CallingMode />
{:else}
  <!-- Active session view -->
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="hidden md:block">
      <StatusBar />
    </div>
    <MobileRuntimeStatus />
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
          Kill &amp; Continue
        </button>
        <button class="border-destructive/30 hover:bg-destructive/20 rounded border px-3 py-1 text-xs font-medium" onclick={() => dismissConflicts()}> Dismiss </button>
      </div>
    {/if}
    <MessageList />
    <InlineSelect />
    <PendingSteeringMessages />
    <ActiveSessionBar />
    <InputBar />
  </div>
{/if}
