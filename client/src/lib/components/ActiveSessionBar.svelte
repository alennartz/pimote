<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession, closeSession, newSessionInProject } from '$lib/stores/session-registry.svelte.js';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
  import { getSessionPillSwipeHintShown, setSessionPillSwipeHintShown } from '$lib/stores/persistence.js';
  import { shouldOpenSessionPillActions } from './session-pill-gesture.js';

  const uiQueue = getExtensionUiQueue();

  let mobileActionsSessionId = $state<string | null>(null);
  let suppressTapSessionId = $state<string | null>(null);
  let hintSessionId = $state<string | null>(null);

  let touchSessionId: string | null = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let touchDeltaY = 0;
  let hintStartTimer: ReturnType<typeof setTimeout> | null = null;
  let hintClearTimer: ReturnType<typeof setTimeout> | null = null;
  let swipeHintShown = getSessionPillSwipeHintShown();

  function resetTouchState() {
    touchSessionId = null;
    touchStartX = 0;
    touchStartY = 0;
    touchDeltaX = 0;
    touchDeltaY = 0;
  }

  function openMobileActions(sessionId: string) {
    mobileActionsSessionId = sessionId;
    suppressTapSessionId = sessionId;
    resetTouchState();
  }

  function markSwipeHintSeen() {
    if (swipeHintShown) return;
    swipeHintShown = true;
    setSessionPillSwipeHintShown(true);
  }

  function handleTouchStart(sessionId: string, e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchSessionId = sessionId;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchDeltaX = 0;
    touchDeltaY = 0;
  }

  function handleTouchMove(sessionId: string, e: TouchEvent) {
    if (touchSessionId !== sessionId || e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchDeltaX = touch.clientX - touchStartX;
    touchDeltaY = touch.clientY - touchStartY;
  }

  function handleTouchEnd(sessionId: string) {
    if (touchSessionId !== sessionId) return;

    if (shouldOpenSessionPillActions(touchDeltaX, touchDeltaY)) {
      markSwipeHintSeen();
      openMobileActions(sessionId);
      return;
    }

    resetTouchState();
  }

  function handlePillClick(sessionId: string) {
    if (suppressTapSessionId === sessionId) {
      suppressTapSessionId = null;
      return;
    }

    if (mobileActionsSessionId === sessionId) {
      mobileActionsSessionId = null;
      return;
    }

    mobileActionsSessionId = null;
    switchToSession(sessionId);
  }

  async function archiveAndCloseSession(sessionId: string) {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return;

    try {
      await connection.send({
        type: 'archive_session',
        folderPath: session.folderPath,
        sessionId,
        archived: true,
      });
      mobileActionsSessionId = null;
      closeSession(sessionId);
    } catch (e) {
      console.error('Failed to archive session:', e);
    }
  }

  function closeFromTray(sessionId: string) {
    mobileActionsSessionId = null;
    closeSession(sessionId);
  }

  onMount(() => {
    const handleOutsidePointerDown = (e: PointerEvent) => {
      if (!mobileActionsSessionId) return;
      const target = e.target;
      if (target instanceof Element && target.closest('.session-pill-bar-root')) return;
      mobileActionsSessionId = null;
    };

    window.addEventListener('pointerdown', handleOutsidePointerDown);

    return () => {
      window.removeEventListener('pointerdown', handleOutsidePointerDown);
      if (hintStartTimer) clearTimeout(hintStartTimer);
      if (hintClearTimer) clearTimeout(hintClearTimer);
    };
  });

  $effect(() => {
    if (swipeHintShown) return;
    if (sessionRegistry.activeSessions.length === 0) return;
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;

    const targetSessionId = sessionRegistry.viewedSessionId ?? sessionRegistry.activeSessions[0]?.sessionId;
    if (!targetSessionId) return;

    if (hintStartTimer) clearTimeout(hintStartTimer);
    if (hintClearTimer) clearTimeout(hintClearTimer);

    hintStartTimer = setTimeout(() => {
      hintSessionId = targetSessionId;
      hintClearTimer = setTimeout(() => {
        hintSessionId = null;
      }, 900);
    }, 900);
  });
</script>

{#if sessionRegistry.activeSessions.length > 0}
  <div class="session-pill-bar-root border-border bg-muted/30 flex shrink-0 flex-col gap-1.5 border-t px-2 py-1.5">
    {#if mobileActionsSessionId && sessionRegistry.sessions[mobileActionsSessionId]}
      {@const actionSession = sessionRegistry.sessions[mobileActionsSessionId]}
      <div class="bg-popover text-popover-foreground ring-foreground/10 flex items-center gap-2 rounded-2xl px-2 py-1 shadow-md ring-1 md:hidden">
        <div class="min-w-0 flex-1 px-1">
          <div class="truncate text-xs font-medium">{actionSession.projectName}</div>
          <div class="text-muted-foreground text-[11px]">Session actions</div>
        </div>
        <button
          class="hover:bg-accent hover:text-accent-foreground flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
          onclick={() => void archiveAndCloseSession(actionSession.sessionId)}
        >
          <Archive class="size-3" />
          <span>Archive</span>
        </button>
        <button
          class="text-destructive hover:bg-destructive/10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
          onclick={() => closeFromTray(actionSession.sessionId)}
        >
          <X class="size-3" />
          <span>Close</span>
        </button>
      </div>
    {/if}

    <div class="flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden" onscroll={() => (mobileActionsSessionId = null)}>
      {#each sessionRegistry.activeSessions as session (session.sessionId)}
        {@const isViewed = sessionRegistry.viewedSessionId === session.sessionId}
        {@const hasPendingUi = uiQueue.hasRequestForSession(session.sessionId)}
        <button
          class="group/chip {isViewed
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'} flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors select-none {hintSessionId ===
          session.sessionId
            ? 'session-pill-swipe-hint'
            : ''}"
          style="touch-action: pan-x;"
          onclick={() => handlePillClick(session.sessionId)}
          onauxclick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeSession(session.sessionId);
            }
          }}
          ontouchstart={(e) => handleTouchStart(session.sessionId, e)}
          ontouchmove={(e) => handleTouchMove(session.sessionId, e)}
          ontouchend={() => handleTouchEnd(session.sessionId)}
          ontouchcancel={resetTouchState}
          title={session.projectName}
        >
          <span class="relative flex size-2">
            {#if hasPendingUi}
              <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
            {:else if session.status === 'working'}
              <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
            {:else if session.needsAttention}
              <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
            {:else}
              <span class="relative inline-flex size-2 rounded-full bg-gray-400"></span>
            {/if}
          </span>
          <span class="max-w-[80px] truncate">{session.projectName}</span>
          <span
            class="{isViewed
              ? 'text-primary-foreground/50 hover:bg-primary-foreground/20 hover:text-primary-foreground'
              : 'text-secondary-foreground/50 hover:bg-secondary-foreground/20 hover:text-secondary-foreground'} -mr-1 ml-0.5 hidden items-center justify-center rounded-full p-0.5 transition-colors md:flex md:opacity-0 md:group-hover/chip:opacity-100"
            role="button"
            tabindex="-1"
            title="Close session"
            onclick={(e) => {
              e.stopPropagation();
              closeSession(session.sessionId);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                closeSession(session.sessionId);
              }
            }}
          >
            <X class="size-3" />
          </span>
        </button>
      {/each}

      {#if sessionRegistry.viewedSessionId}
        <button
          class="border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors"
          title="New session in {sessionRegistry.viewed?.projectName}"
          onclick={() => newSessionInProject(sessionRegistry.viewedSessionId!)}
        >
          <Plus class="size-3" />
          <span>New</span>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  @keyframes session-pill-swipe-nudge {
    0%,
    100% {
      transform: translateY(0);
    }

    35% {
      transform: translateY(-8px);
    }

    65% {
      transform: translateY(-3px);
    }
  }

  .session-pill-swipe-hint {
    animation: session-pill-swipe-nudge 900ms ease-in-out;
  }
</style>
