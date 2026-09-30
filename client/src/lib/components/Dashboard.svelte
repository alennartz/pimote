<script lang="ts">
  import { untrack } from 'svelte';
  import ProjectList from '$lib/components/ProjectList.svelte';
  import ManagerChat from '$lib/components/ManagerChat.svelte';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
  import { getSessionDisplayName } from '$lib/session-summary.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import Bot from '@lucide/svelte/icons/bot';
  import X from '@lucide/svelte/icons/x';

  let managerOpen = $state(false);

  // Seed the project list per connection: reconnects drop the guard so the
  // dashboard refetches against the fresh connection.
  let loadedProjectsForCurrentConnection = false;

  $effect(() => {
    const status = connection.status;

    if (status === 'connected') {
      if (!loadedProjectsForCurrentConnection) {
        loadedProjectsForCurrentConnection = true;
        untrack(() => {
          void projectStore.loadProjects();
        });
      }
      return;
    }

    loadedProjectsForCurrentConnection = false;
  });

  function statusClass(sessionId: string): string {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return 'bg-muted-foreground/40';
    if (session.isStreaming) return 'bg-status-connected animate-pulse';
    if (session.needsAttention) return 'bg-warning';
    if (session.status === 'working') return 'bg-blue-400';
    return 'bg-muted-foreground/40';
  }

  function statusLabel(sessionId: string): string {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return 'idle';
    if (session.isStreaming) return 'streaming';
    if (session.needsAttention) return 'needs attention';
    if (session.status === 'working') return 'working';
    return 'idle';
  }

  function lastActivity(sessionId: string): string {
    const session = sessionRegistry.sessions[sessionId];
    if (!session?.lastBotActivityTimestamp) return '';
    return formatRelativeTime(session.lastBotActivityTimestamp);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-10 px-5 pt-12 pb-28 md:pt-16">
    <!-- Brand -->
    <div class="flex flex-col items-center gap-1.5">
      <div class="flex items-center gap-2.5">
        <img src="/pwa/icon-512.png" alt="" class="border-border size-9 rounded-xl border object-cover" />
        <span class="text-foreground text-base font-semibold tracking-tight">Pimote</span>
      </div>
    </div>

    <!-- Manager: spotlight when idle, conversation only once in use (desktop) -->
    <div class="hidden md:block">
      <ManagerChat />
    </div>
    <!-- Manager affordance on mobile: opens the fullscreen sheet -->
    <button
      class="border-border bg-secondary/60 hover:border-ring hover:ring-ring flex w-full items-center gap-2.5 rounded-2xl border px-4 py-3 text-left shadow-lg transition-colors hover:ring-1 md:hidden"
      onclick={() => (managerOpen = true)}
    >
      <Bot class="text-muted-foreground size-4 shrink-0" />
      <span class="text-muted-foreground text-sm">Ask the manager…</span>
    </button>

    <!-- Continue: open sessions as cards -->
    {#if sessionRegistry.activeSessions.length > 0}
      <section>
        <div class="text-muted-foreground mb-3 flex items-baseline gap-2">
          <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">Continue</h2>
          <span class="text-xs">{sessionRegistry.activeSessions.length} open</span>
        </div>
        <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {#each sessionRegistry.activeSessions as session (session.sessionId)}
            <button
              class="bg-surface border-border hover:border-ring focus-visible:ring-ring rounded-xl border p-3 text-left transition-colors focus-visible:ring-1 focus-visible:outline-none"
              onclick={() => switchToSession(session.sessionId)}
            >
              <div class="flex items-center gap-2">
                <span class="size-1.5 shrink-0 rounded-full {statusClass(session.sessionId)}"></span>
                <span class="text-foreground min-w-0 flex-1 truncate text-[13px] font-semibold">{session.projectName}</span>
              </div>
              <div class="text-muted-foreground mt-1 truncate text-xs">
                {getSessionDisplayName(session)}
              </div>
              <div class="text-muted-foreground/80 mt-2 flex items-center gap-1.5 text-[11px]">
                <span>{statusLabel(session.sessionId)}</span>
                {#if lastActivity(session.sessionId)}
                  <span>·</span>
                  <span>{lastActivity(session.sessionId)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Projects -->
    <section>
      <div class="text-muted-foreground mb-3 flex items-baseline gap-2">
        <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">Projects</h2>
        {#if projectStore.projects.length > 0}
          <span class="text-xs">{projectStore.projects.length}</span>
        {/if}
      </div>
      <ProjectList />
    </section>
  </div>
</div>

{#if managerOpen}
  <!-- Mobile manager sheet -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-30 bg-black/50 md:hidden" onclick={() => (managerOpen = false)} onkeydown={(e) => e.key === 'Escape' && (managerOpen = false)}></div>
  <div class="bg-background fixed inset-0 z-40 flex flex-col md:hidden">
    <div class="border-border flex h-12 shrink-0 items-center justify-between border-b px-3">
      <div class="flex items-center gap-2">
        <Bot class="text-muted-foreground size-4" />
        <span class="text-foreground text-sm font-semibold">Manager</span>
      </div>
      <button class="text-muted-foreground hover:text-foreground rounded-md p-1" onclick={() => (managerOpen = false)} title="Close manager">
        <X class="size-5" />
      </button>
    </div>
    <div class="min-h-0 flex-1">
      <ManagerChat variant="expanded" />
    </div>
  </div>
{/if}
