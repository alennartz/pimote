<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import ProjectList from '$lib/components/ProjectList.svelte';
  import ManagerChat from '$lib/components/ManagerChat.svelte';
  import SwipeableCard, { closeOpenSwipeCard } from '$lib/components/SwipeableCard.svelte';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { closeSession, openExistingSession, sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
  import { getSessionDisplayName } from '$lib/session-summary.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import Archive from '@lucide/svelte/icons/archive';
  import Bot from '@lucide/svelte/icons/bot';
  import X from '@lucide/svelte/icons/x';

  let managerOpen = $state(false);

  // --- Continue: swipe-to-close/archive -------------------------------------
  //
  // A swiped-away card is replaced in the grid by a lingering ghost with an
  // Undo affordance (5s). The ghost records the session it sat after, so the
  // list reconstructs with the ghost where the card used to be.

  interface ContinueGhost {
    id: string;
    label: string;
    displayName: string;
    /** Session id this ghost should render before (its old position), if that session still exists. */
    anchorSessionId: string | null;
    undo: () => void;
  }

  let ghosts = $state<ContinueGhost[]>([]);
  const ghostTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

  type ContinueItem = { kind: 'session'; sessionId: string } | { kind: 'ghost'; ghost: ContinueGhost };

  const displayItems = $derived.by(() => {
    const items: ContinueItem[] = [];
    const pending = [...ghosts];
    for (const session of sessionRegistry.activeSessions) {
      for (let i = 0; i < pending.length; ) {
        if (pending[i].anchorSessionId === session.sessionId) {
          items.push({ kind: 'ghost', ghost: pending.splice(i, 1)[0] });
        } else {
          i++;
        }
      }
      items.push({ kind: 'session', sessionId: session.sessionId });
    }
    while (pending.length > 0) items.push({ kind: 'ghost', ghost: pending.shift()! });
    return items;
  });

  function addGhost(ghost: Omit<ContinueGhost, 'id'>) {
    const id = crypto.randomUUID();
    ghosts.push({ ...ghost, id });
    ghostTimers.set(
      id,
      setTimeout(() => dismissGhost(id), 5000),
    );
  }

  function dismissGhost(id: string) {
    const timer = ghostTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      ghostTimers.delete(id);
    }
    ghosts = ghosts.filter((g) => g.id !== id);
  }

  async function undoGhost(ghost: ContinueGhost) {
    dismissGhost(ghost.id);
    try {
      await ghost.undo();
    } catch (e) {
      console.error('Undo failed:', e);
    }
  }

  onDestroy(() => {
    for (const timer of ghostTimers.values()) clearTimeout(timer);
  });

  function anchorAfter(sessionId: string): string | null {
    const sessions = sessionRegistry.activeSessions;
    const index = sessions.findIndex((s) => s.sessionId === sessionId);
    return sessions[index + 1]?.sessionId ?? null;
  }

  async function closeFromHome(sessionId: string): Promise<boolean> {
    // Capture metadata up front — the registry entry disappears on session_closed.
    const session = sessionRegistry.sessions[sessionId];
    const folderPath = session?.folderPath ?? '';
    const displayName = (session ? getSessionDisplayName(session) : null) ?? 'Session';
    const anchor = anchorAfter(sessionId);
    try {
      await connection.send({ type: 'close_session', sessionId });
    } catch (e) {
      console.error('Failed to close session:', e);
      return false;
    }
    addGhost({
      label: 'Session closed',
      displayName,
      anchorSessionId: anchor,
      undo: () => void openExistingSession(sessionId, folderPath, { switchTo: false }),
    });
    return true;
  }

  async function archiveFromHome(sessionId: string): Promise<boolean> {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return false;
    const folderPath = session.folderPath;
    const displayName = getSessionDisplayName(session) ?? session.projectName;
    const anchor = anchorAfter(sessionId);
    try {
      const response = await connection.send({ type: 'archive_session', folderPath, sessionIds: [sessionId], archived: true });
      if (!response.success) {
        console.error('Failed to archive session:', response.error);
        return false;
      }
    } catch (e) {
      console.error('Failed to archive session:', e);
      return false;
    }
    // Archived sessions leave the Continue list — the card goes with it.
    closeSession(sessionId);
    addGhost({
      label: 'Session archived',
      displayName,
      anchorSessionId: anchor,
      undo: async () => {
        await connection.send({ type: 'archive_session', folderPath, sessionIds: [sessionId], archived: false });
        await openExistingSession(sessionId, folderPath, { switchTo: false });
      },
    });
    return true;
  }

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

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" onscroll={closeOpenSwipeCard}>
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
      class="border-border bg-secondary/60 hover:border-ring hover:ring-ring active:bg-secondary flex min-h-11 w-full items-center gap-2.5 rounded-2xl border px-4 py-3 text-left shadow-lg transition-colors hover:ring-1 md:hidden"
      onclick={() => (managerOpen = true)}
    >
      <Bot class="text-muted-foreground size-5 shrink-0" />
      <span class="text-muted-foreground text-[15px]">Ask the manager…</span>
    </button>

    <!-- Continue: open sessions as cards -->
    {#if sessionRegistry.activeSessions.length > 0 || ghosts.length > 0}
      <section>
        <div class="text-muted-foreground mb-3 flex items-baseline gap-2">
          <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">Continue</h2>
          <span class="text-xs">{sessionRegistry.activeSessions.length} open</span>
        </div>
        <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {#each displayItems as item (item.kind === 'session' ? item.sessionId : item.ghost.id)}
            {#if item.kind === 'session'}
              {@const session = sessionRegistry.sessions[item.sessionId]}
              <SwipeableCard
                actionLeft={{ label: 'Close', icon: X, onAction: () => closeFromHome(item.sessionId) }}
                actionRight={{ label: 'Archive', icon: Archive, onAction: () => archiveFromHome(item.sessionId) }}
              >
                <button
                  class="bg-card border-border hover:border-ring focus-visible:ring-ring active:bg-secondary w-full rounded-xl border p-3.5 text-left transition-colors focus-visible:ring-1 focus-visible:outline-none"
                  onclick={() => switchToSession(item.sessionId)}
                >
                  <div class="flex items-center gap-2">
                    <span class="size-2 shrink-0 rounded-full {statusClass(item.sessionId)}"></span>
                    <span class="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{session?.projectName}</span>
                  </div>
                  {#if session}
                    <div class="text-muted-foreground mt-1 truncate text-xs">
                      {getSessionDisplayName(session)}
                    </div>
                    <div class="text-muted-foreground/80 mt-2 flex items-center gap-1.5 text-xs">
                      <span>{statusLabel(item.sessionId)}</span>
                      {#if lastActivity(item.sessionId)}
                        <span>·</span>
                        <span>{lastActivity(item.sessionId)}</span>
                      {/if}
                    </div>
                  {/if}
                </button>
              </SwipeableCard>
            {:else}
              <div class="border-border/60 bg-muted/30 flex min-h-20 items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3" out:fade={{ duration: 250 }}>
                <div class="min-w-0">
                  <p class="text-muted-foreground text-sm font-medium">{item.ghost.label}</p>
                  <p class="text-muted-foreground/70 mt-0.5 truncate text-xs">{item.ghost.displayName}</p>
                </div>
                <button
                  class="text-primary hover:bg-accent active:bg-accent/80 shrink-0 rounded-md px-2 py-1.5 text-sm font-medium transition-colors"
                  onclick={() => void undoGhost(item.ghost)}
                >
                  Undo
                </button>
              </div>
            {/if}
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
    <div class="border-border flex min-h-12 shrink-0 items-center justify-between border-b px-3" style="padding-top: max(0.25rem, env(safe-area-inset-top));">
      <div class="flex items-center gap-2">
        <Bot class="text-muted-foreground size-5" />
        <span class="text-foreground text-sm font-semibold">Manager</span>
      </div>
      <button
        class="text-muted-foreground hover:text-foreground -mr-1.5 flex size-11 items-center justify-center rounded-md transition-colors"
        onclick={() => (managerOpen = false)}
        title="Close manager"
      >
        <X class="size-5" />
      </button>
    </div>
    <div class="min-h-0 flex-1">
      <ManagerChat variant="expanded" />
    </div>
  </div>
{/if}
