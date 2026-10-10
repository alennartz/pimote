<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import HomeToolbar from '$lib/components/HomeToolbar.svelte';
  import FolderList from '$lib/components/FolderList.svelte';
  import { isPlaceholderSessionId, submitManagerMessage, type ManagerSubmitPorts } from '$lib/manager-composer.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import SwipeableCard, { closeOpenSwipeCard } from '$lib/components/SwipeableCard.svelte';
  import type { SwipeActionOutcome } from '$lib/components/swipe-action.js';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { closeSession, openExistingSession, sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
  import { getSessionDisplayName } from '$lib/session-summary.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import Archive from '@lucide/svelte/icons/archive';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import X from '@lucide/svelte/icons/x';

  let search = $state('');
  let scrollElement = $state<HTMLDivElement | null>(null);
  // Toolbar box mode: search (default) or manager. Pure input routing — the
  // toggle opens nothing; the session opens on send (owner ruling). Old
  // manager sessions surface in the toolbar's dropdown while in manager mode.
  let managerMode = $state(false);
  // One draft shared by the toolbar box and the manager area's composer.
  let managerDraft = $state('');
  // Busy state while one submit is in flight: both composers disable their
  // send affordances; the shared operation guards re-entry against doubles.
  let managerBusy = $state(false);
  let mobile = $derived(isMobileViewport());
  /** Manager controls wait for a usable root fact and connected readiness. */
  let managerReady = $derived(connection.ready && connection.managerRoot !== null);

  // --- Manager area: one shared submit operation ----------------------------
  //
  // Every manager-area entry control routes through here. The continue-or-
  // open-new decision and the prompt/open/navigate sequence live in
  // `submitManagerMessage`; this wiring supplies the ordinary session seams.
  // A rejected submit keeps the shared draft.

  const managerPorts: ManagerSubmitPorts = {
    openManagerSession: async (managerRoot) => {
      try {
        const response = await connection.send({ type: 'open_session', folderPath: managerRoot });
        const sessionId = (response.data as { sessionId?: string } | undefined)?.sessionId;
        return { success: response.success, ...(sessionId !== undefined ? { sessionId } : {}) };
      } catch (e) {
        console.error('Failed to open manager session:', e);
        return { success: false };
      }
    },
    prompt: async (sessionId, message) => {
      try {
        return (await connection.send({ type: 'prompt', sessionId, message })).success;
      } catch (e) {
        console.error('Failed to prompt manager session:', e);
        return false;
      }
    },
    switchToSession,
  };

  async function submitManagerDraft(text: string): Promise<void> {
    const managerRoot = connection.managerRoot;
    if (!managerRoot || !managerReady) return;
    managerBusy = true;
    try {
      const viewed = sessionRegistry.viewed;
      const sent = await submitManagerMessage(
        {
          viewed: viewed ? { sessionId: viewed.sessionId } : undefined,
          // A viewed manager session continues; placeholders and code sessions
          // do not count as manager identity. Lexical equality is deliberate:
          // the canonical identity fact lives with the server (attachment
          // rule), and no folder row ever points at the manager root, so a
          // manager session opened through this UI always carries the
          // canonical path (review finding 7 disposition; see DR-059).
          viewedIsManager: viewed != null && !isPlaceholderSessionId(viewed.sessionId) && viewed.folderPath === managerRoot,
          managerRoot,
          text,
        },
        managerPorts,
      );
      if (sent) managerDraft = '';
    } finally {
      managerBusy = false;
    }
  }

  // Continue starts expanded — the header keeps the open count visible and
  // lets the user fold it away. It is not rendered on mobile at all: there,
  // active sessions surface under their folder's half-open expander instead.
  let continueOpen = $state(true);

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

  async function closeFromHome(sessionId: string): Promise<SwipeActionOutcome> {
    // Capture metadata up front — the registry entry disappears on session_closed.
    const session = sessionRegistry.sessions[sessionId];
    const folderPath = session?.folderPath ?? '';
    const displayName = (session ? getSessionDisplayName(session) : null) ?? 'Session';
    const anchor = anchorAfter(sessionId);
    try {
      await connection.send({ type: 'close_session', sessionId });
    } catch (e) {
      console.error('Failed to close session:', e);
      return 'stay';
    }
    addGhost({
      label: 'Session closed',
      displayName,
      anchorSessionId: anchor,
      undo: () => void openExistingSession(sessionId, folderPath, { switchTo: false }),
    });
    return 'collapse';
  }

  async function archiveFromHome(sessionId: string): Promise<SwipeActionOutcome> {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return 'stay';
    const folderPath = session.folderPath;
    const displayName = getSessionDisplayName(session) ?? session.projectName;
    const anchor = anchorAfter(sessionId);
    try {
      const response = await connection.send({ type: 'archive_session', folderPath, sessionIds: [sessionId], archived: true });
      if (!response.success) {
        console.error('Failed to archive session:', response.error);
        return 'stay';
      }
    } catch (e) {
      console.error('Failed to archive session:', e);
      return 'stay';
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
    return 'collapse';
  }

  // Seed the folder list per connection. The store owns the freshness policy:
  // a warm cache serves remounts (server events keep it current), reconnects
  // refetch via the disconnect invalidation.
  $effect(() => {
    if (connection.status === 'connected') {
      untrack(() => {
        void folderStore.ensureLoaded();
      });
    }
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

<div class="flex min-h-0 flex-1">
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" bind:this={scrollElement} onscroll={closeOpenSwipeCard}>
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-10 px-5 pt-12 pb-28 md:max-w-4xl md:pt-16">
      <!-- Brand -->
      <div class="flex flex-col items-center gap-1.5">
        <div class="flex items-center gap-2.5">
          <img src="/pwa/icon-512.png" alt="" class="border-border size-9 rounded-xl border object-cover" />
          <span class="text-foreground text-base font-semibold tracking-tight">Pimote</span>
        </div>
      </div>

      <!-- One box: search by default; the leading button toggles it into the
         manager (AI) mode. Same structure on mobile and desktop — only the
         touch/typography sizing differs. -->
      <HomeToolbar bind:search bind:managerMode bind:managerDraft {managerReady} busy={managerBusy} onSubmitManager={submitManagerDraft} />

      <!-- Continue: open sessions as cards. Desktop only — mobile drops the
         section completely rather than nesting an expander under the toolbar. -->
      {#if !mobile && (sessionRegistry.activeSessions.length > 0 || ghosts.length > 0)}
        <section>
          <div class="text-muted-foreground mb-3 flex items-center gap-2">
            <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">
              <button
                type="button"
                class="hover:text-foreground focus-visible:ring-ring flex min-h-8 items-center gap-1.5 rounded-md pr-1 text-left transition-colors focus-visible:ring-1 focus-visible:outline-none"
                aria-expanded={continueOpen}
                onclick={() => (continueOpen = !continueOpen)}
              >
                <ChevronRight class="size-3.5 shrink-0 transition-transform {continueOpen ? 'rotate-90' : ''}" />
                Continue
              </button>
            </h2>
            <span class="text-xs">{sessionRegistry.activeSessions.length} open</span>
          </div>
          {#if continueOpen}
            <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
          {/if}
        </section>
      {/if}

      <!-- Folders: header + list actions live with the list itself -->
      <section>
        <FolderList {search} {scrollElement} />
      </section>
    </div>
  </div>
</div>
