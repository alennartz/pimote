<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { ContextMenu } from 'bits-ui';
  import { onMount } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession, closeSession, removeSessionOptimistically, newSessionInProject } from '$lib/stores/session-registry.svelte.js';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
  import { getSessionPillSwipeHintShown, setSessionPillSwipeHintShown } from '$lib/stores/persistence.js';
  import { getSessionChipLabel, getSessionDisplayName } from '$lib/session-summary.js';
  import { getSessionPillIconColor } from '$lib/session-pill-status.js';
  import { SESSION_CHIP_GAP, SESSION_CHIP_SLOP, flowPasses, flowResistance, resolveChipGesture, shouldOpenSessionPillActions, type ChipGesture } from './session-pill-gesture.js';
  import FolderNatureIcon, { folderIconKind } from './FolderNatureIcon.svelte';

  const uiQueue = getExtensionUiQueue();

  let mobileActionsSessionId = $state<string | null>(null);
  let openContextMenuSessionId = $state<string | null>(null);
  let hintSessionId = $state<string | null>(null);
  let deleteSessionId = $state<string | null>(null);
  let railEl = $state<HTMLDivElement | null>(null);
  let trackEl = $state<HTMLDivElement | null>(null);

  let hintStartTimer: ReturnType<typeof setTimeout> | null = null;
  let hintClearTimer: ReturnType<typeof setTimeout> | null = null;
  let swipeHintShown = getSessionPillSwipeHintShown();

  function openMobileActions(sessionId: string) {
    openContextMenuSessionId = null;
    mobileActionsSessionId = sessionId;
  }

  function handleContextMenuOpenChange(sessionId: string, open: boolean) {
    if (open) {
      openContextMenuSessionId = sessionId;
    } else if (openContextMenuSessionId === sessionId) {
      openContextMenuSessionId = null;
    }
  }

  function markSwipeHintSeen() {
    if (swipeHintShown) return;
    swipeHintShown = true;
    setSessionPillSwipeHintShown(true);
  }

  function handlePillClick(sessionId: string) {
    if (mobileActionsSessionId === sessionId) {
      mobileActionsSessionId = null;
      return;
    }

    mobileActionsSessionId = null;
    switchToSession(sessionId);
  }

  /* ---------- chip order ---------- */

  /** The rail gesture in flight: a flow swipe while the tray is open, or a
   *  plain press that the browser turns into a click. */
  interface RailPointer {
    pointerId: number;
    chip: HTMLElement | null;
    startX: number;
    startY: number;
    moved: boolean;
    mode: ChipGesture;
  }

  let pointer: RailPointer | null = null;
  let flowBaseX = 0;
  let flowLeftover = 0;

  function chipElements(): HTMLElement[] {
    if (!trackEl) return [];
    return [...trackEl.querySelectorAll<HTMLElement>('[data-session-chip]')];
  }

  /**
   * The flow row. While the tray is open the tray's chip is pinned at the rail
   * centre and the rest sit around it in a projected order the swipe advances.
   *
   * Geometry is measured once, when the flow is established: the order is
   * projected locally and the registry moves only when the swipe ends, so a
   * pass never re-measures a row that is mid-glide and never re-renders the
   * chip list under the finger. That is what keeps the swipe smooth.
   */
  interface FlowState {
    /** Chip ids in the order the row currently shows. */
    ids: string[];
    /** Chip widths measured when the flow was established. */
    widths: Record<string, number>;
    heights: Record<string, number>;
    /** Where the pinned chip started, for the one registry move on release. */
    fromIndex: number;
    /** At least one pass happened this gesture. */
    moved: boolean;
  }

  let flowState: FlowState | null = null;

  function establishFlow(ids: string[], anchorId: string): FlowState {
    const widths: Record<string, number> = Object.create(null);
    const heights: Record<string, number> = Object.create(null);
    for (const element of chipElements()) {
      const id = element.dataset.sessionChip ?? '';
      const rect = element.getBoundingClientRect();
      widths[id] = rect.width || 80;
      heights[id] = rect.height || 24;
    }
    return { ids: [...ids], widths, heights, fromIndex: Math.max(0, ids.indexOf(anchorId)), moved: false };
  }

  /** Pin the tray's chip at the rail centre and lay the others out around it. */
  function layoutFlow(): void {
    const anchorId = mobileActionsSessionId;
    if (!flowState || !railEl || !trackEl || !anchorId) return;
    const index = flowState.ids.indexOf(anchorId);
    if (index < 0) return;
    const widthOf = (id: string) => flowState?.widths[id] ?? 80;
    const elements = chipElements();
    const rowHeight = Math.max(...flowState.ids.map((id) => flowState?.heights[id] ?? 24), 0);
    const anchorX = Math.max(2, Math.round((railEl.clientWidth - widthOf(anchorId)) / 2));
    const positions: Record<string, number> = Object.create(null);
    positions[anchorId] = anchorX;
    let x = anchorX - SESSION_CHIP_GAP;
    for (let i = index - 1; i >= 0; i--) {
      const id = flowState.ids[i];
      x -= widthOf(id);
      positions[id] = x;
      x -= SESSION_CHIP_GAP;
    }
    x = anchorX + widthOf(anchorId) + SESSION_CHIP_GAP;
    for (let i = index + 1; i < flowState.ids.length; i++) {
      const id = flowState.ids[i];
      positions[id] = x;
      x += widthOf(id) + SESSION_CHIP_GAP;
    }
    trackEl.style.height = `${rowHeight}px`;
    for (const element of elements) {
      const id = element.dataset.sessionChip ?? '';
      const left = positions[id] as number | undefined;
      if (left === undefined) {
        // A chip that arrived after the flow was established has no slot yet.
        element.classList.remove('session-chip-flow');
        element.style.left = '';
        element.style.top = '';
        element.style.transform = '';
        continue;
      }
      element.classList.add('session-chip-flow');
      element.style.left = `${left}px`;
      element.style.top = `${Math.max(0, (rowHeight - (flowState.heights[id] ?? rowHeight)) / 2)}px`;
      element.style.zIndex = id === anchorId ? '4' : '1';
      // The trailing movement between two passes rides on top of the slots, so
      // the row follows the finger as closely as it snaps to them.
      element.style.transform = id === anchorId || !flowLeftover ? '' : `translateX(${flowLeftover}px)`;
    }
  }

  function clearFlowLayout(): void {
    flowState = null;
    for (const element of chipElements()) {
      element.classList.remove('session-chip-flow');
      element.style.left = '';
      element.style.top = '';
      element.style.zIndex = '';
      element.style.transform = '';
    }
    if (trackEl) trackEl.style.height = '';
  }

  function stepFlow(clientX: number): void {
    const anchorId = mobileActionsSessionId;
    if (!flowState || !anchorId) return;
    const index = flowState.ids.indexOf(anchorId);
    if (index < 0) return;
    const step = flowPasses({
      index,
      count: flowState.ids.length,
      deltaX: clientX - flowBaseX,
      widthAt: (position) => flowState?.widths[flowState.ids[position] ?? ''] ?? 80,
    });
    flowBaseX = clientX - step.leftover;
    if (step.passes > 0 && step.index !== index) {
      flowState.moved = true;
      flowState.ids.splice(index, 1);
      flowState.ids.splice(step.index, 0, anchorId);
    }
    const direction = step.leftover < 0 ? 1 : -1;
    const target = flowState.ids.indexOf(anchorId);
    const blocked = target + direction < 0 || target + direction >= flowState.ids.length;
    flowLeftover = blocked ? flowResistance(step.leftover) : step.leftover;
    layoutFlow();
  }

  function endFlow(): void {
    flowLeftover = 0;
    const anchorId = mobileActionsSessionId;
    const state = flowState;
    if (!state || !anchorId) return;
    const finalIndex = state.ids.indexOf(anchorId);
    const moved = state.moved && finalIndex !== state.fromIndex;
    state.moved = false;
    layoutFlow();
    if (!moved) return;
    // One registry move for the whole gesture, then one whole-order write.
    sessionRegistry.moveSession(state.fromIndex, finalIndex);
    state.fromIndex = finalIndex;
    sessionRegistry.pushSessionOrder();
  }

  /**
   * The rail owns two gestures and nothing else. A sideways swipe with the tray
   * open flows the row around the pinned chip. An upward swipe on a chip opens
   * that chip's tray. A press that travels nowhere is left to the browser, so
   * the chip's own click handler selects — the same click path the bar always
   * had. Sideways movement with the tray closed is native rail scrolling.
   */
  function railPointerGesture(node: HTMLDivElement): () => void {
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = event.target;
      const chip = target instanceof Element ? target.closest<HTMLElement>('[data-session-chip]') : null;
      pointer = {
        pointerId: event.pointerId,
        chip,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        mode: 'none',
      };
    };

    const onMove = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.pointerId) return;
      const deltaX = event.clientX - pointer.startX;
      const deltaY = event.clientY - pointer.startY;
      if (!pointer.moved) {
        if (Math.hypot(deltaX, deltaY) <= SESSION_CHIP_SLOP) return;
        pointer.moved = true;
        pointer.mode = resolveChipGesture({ trayOpen: !!mobileActionsSessionId, moved: true, deltaX, deltaY });
        if (pointer.mode === 'flow') {
          flowBaseX = pointer.startX + Math.sign(deltaX) * SESSION_CHIP_SLOP;
          flowLeftover = 0;
          if (flowState) flowState.moved = false;
        }
      }
      if (pointer.mode === 'flow') stepFlow(event.clientX);
    };

    const onUp = (event: PointerEvent) => {
      const active = pointer;
      pointer = null;
      if (!active || event.pointerId !== active.pointerId) return;
      if (active.mode === 'flow') {
        endFlow();
        return;
      }
      const chipId = active.chip?.dataset.sessionChip;
      if (!chipId) return;
      if (shouldOpenSessionPillActions(event.clientX - active.startX, event.clientY - active.startY)) {
        markSwipeHintSeen();
        openMobileActions(chipId);
      }
    };

    const onCancel = () => {
      if (pointer?.mode === 'flow') endFlow();
      pointer = null;
    };

    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onCancel);
    return () => {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
    };
  }

  // The tray decides: with it open the tray's chip pins at the rail centre and
  // the row flows around it; with it closed the rail is one flat scrolling row.
  $effect(() => {
    const trayId = mobileActionsSessionId;
    const ids = sessionRegistry.activeSessions.map((session) => session.sessionId);
    if (!railEl || !trackEl) return;
    if (!trayId || !ids.includes(trayId)) {
      clearFlowLayout();
      return;
    }
    // Establish once per tray opening: re-measuring a gliding row under the
    // finger is what made the swipe stutter.
    const established = flowState !== null && ids.every((id) => flowState!.ids.includes(id));
    if (!established) flowState = establishFlow(ids, trayId);
    else if (!flowState!.moved) flowState!.ids = [...ids];
    layoutFlow();
  });

  function archiveAndCloseSession(sessionId: string) {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return;
    mobileActionsSessionId = null;
    // Remove the chip before the archive request settles. The server still
    // archives the persisted session and closes its runtime asynchronously.
    if (!removeSessionOptimistically(sessionId)) return;

    void connection
      .send({
        type: 'archive_session',
        folderPath: session.folderPath,
        sessionIds: [sessionId],
        archived: true,
      })
      .then((response) => {
        if (!response.success) console.error('Failed to archive session:', response.error);
      })
      .catch((e) => {
        console.error('Failed to archive session:', e);
      });
  }

  function closeFromTray(sessionId: string) {
    mobileActionsSessionId = null;
    closeSession(sessionId);
  }

  async function deleteActiveSession(sessionId: string) {
    const session = sessionRegistry.sessions[sessionId];
    deleteSessionId = null;
    if (!session) return;

    try {
      closeSession(sessionId);
      await connection.send({
        type: 'delete_session',
        folderPath: session.folderPath,
        sessionId,
      });
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
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
          <div class="truncate text-xs font-medium">{getSessionChipLabel(actionSession) ?? actionSession.projectName}</div>
          <div class="text-muted-foreground text-[11px]">Session actions</div>
        </div>
        <button
          class="active:bg-accent active:text-accent-foreground flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
          onclick={() => void archiveAndCloseSession(actionSession.sessionId)}
        >
          <Archive class="size-3" />
          <span>Archive</span>
        </button>
        <button
          class="text-destructive active:bg-destructive/10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
          onclick={() => closeFromTray(actionSession.sessionId)}
        >
          <X class="size-3" />
          <span>Close</span>
        </button>
      </div>
    {/if}

    <div class="flex shrink-0 overflow-x-auto overflow-y-hidden" class:session-rail-flow={!!mobileActionsSessionId} bind:this={railEl} {@attach railPointerGesture}>
      <div class="relative flex w-max shrink-0 items-center gap-1.5" bind:this={trackEl}>
        {#each sessionRegistry.activeSessions as session (session.sessionId)}
          {@const isViewed = sessionRegistry.viewedSessionId === session.sessionId}
          {@const hasPendingUi = uiQueue.hasRequestForSession(session.sessionId)}
          {@const chipLabel = getSessionChipLabel(session) ?? session.projectName}
          <ContextMenu.Root open={openContextMenuSessionId === session.sessionId} onOpenChange={(open) => handleContextMenuOpenChange(session.sessionId, open)}>
            <ContextMenu.Trigger class="shrink-0">
              <button
                class="group/chip {isViewed
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'} flex shrink-0 items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs font-medium transition-colors select-none {hintSessionId ===
                session.sessionId
                  ? 'session-pill-swipe-hint'
                  : ''}"
                style="touch-action: pan-x;"
                data-session-chip={session.sessionId}
                onclick={() => handlePillClick(session.sessionId)}
                onauxclick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeSession(session.sessionId);
                  }
                }}
                title={getSessionDisplayName(session) ?? session.projectName}
              >
                <!-- Folder glyph as the state indicator, colored like the old
                     status dot. The session points at its folder object; the
                     glyph follows the folder's nature. 18px with -my-0.5 keeps
                     the chip at 24px; pl-1 nestles the glyph into the cap
                     curve. -->
                <span class="relative -my-0.5 flex size-4.5 shrink-0">
                  {#if session.status === 'working' && !hasPendingUi}
                    <span class="absolute top-1/2 left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-emerald-400/60"></span>
                  {/if}
                  <FolderNatureIcon
                    kind={folderIconKind(session.folder ?? { nature: 'code', shortcutCount: 0 })}
                    class="relative size-4.5 {getSessionPillIconColor(session, hasPendingUi)}"
                    strokeWidth={2.75}
                  />
                </span>
                <span class="max-w-[80px] truncate">{chipLabel}</span>
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
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content class="bg-popover text-popover-foreground ring-foreground/10 z-50 min-w-36 overflow-hidden rounded-lg p-1 shadow-md ring-1">
                <ContextMenu.Item
                  class="focus:bg-accent focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none max-md:min-h-11 max-md:px-3"
                  onSelect={() => closeSession(session.sessionId)}
                >
                  <X class="size-4" />
                  Close session
                </ContextMenu.Item>
                <ContextMenu.Item
                  class="focus:bg-accent focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none max-md:min-h-11 max-md:px-3"
                  onSelect={() => void archiveAndCloseSession(session.sessionId)}
                >
                  <Archive class="size-4" />
                  Archive session
                </ContextMenu.Item>
                <ContextMenu.Item
                  class="focus:bg-destructive/10 dark:focus:bg-destructive/20 text-destructive flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none max-md:min-h-11 max-md:px-3"
                  onSelect={() => (deleteSessionId = session.sessionId)}
                >
                  <Trash2 class="size-4" />
                  Delete session
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        {/each}

        {#if sessionRegistry.viewedSessionId && !mobileActionsSessionId}
          <button
            class="border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40"
            title="New session in {sessionRegistry.viewed?.projectName}"
            onclick={() => newSessionInProject(sessionRegistry.viewedSessionId!)}
          >
            <Plus class="size-3" />
            <span>New</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<Dialog.Root
  open={deleteSessionId !== null}
  onOpenChange={(open) => {
    if (!open) deleteSessionId = null;
  }}
>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Delete session</Dialog.Title>
      <Dialog.Description>This will permanently delete this session file. This cannot be undone.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteSessionId = null)}>Cancel</Button>
      <Button variant="destructive" onclick={() => deleteSessionId !== null && void deleteActiveSession(deleteSessionId)}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

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

  /* Tray open: the tray's chip pins at the rail centre and the rest are laid
     out around it, gliding when a pass swaps neighbours. */
  :global(.session-chip-flow) {
    position: absolute;
    transition:
      left 160ms ease,
      transform 160ms ease;
    will-change: left, transform;
  }

  .session-rail-flow {
    overflow: hidden;
    /* Flow mode owns the sideways gesture, so the browser must not claim it. */
    touch-action: none;
  }
</style>
