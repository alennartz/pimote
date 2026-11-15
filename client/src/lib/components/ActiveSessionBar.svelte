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
  import {
    SESSION_CHIP_GAP,
    SESSION_CHIP_HOLD_MS,
    SESSION_CHIP_SLOP,
    autoScrollVelocity,
    chipShift,
    dropSlot,
    flowPasses,
    flowResistance,
    insertLineX,
    resolveChipGesture,
    shouldOpenSessionPillActions,
    type ChipBox,
    type ChipGesture,
  } from './session-pill-gesture.js';
  import FolderNatureIcon, { folderIconKind } from './FolderNatureIcon.svelte';

  const uiQueue = getExtensionUiQueue();

  let mobileActionsSessionId = $state<string | null>(null);
  let openContextMenuSessionId = $state<string | null>(null);
  let hintSessionId = $state<string | null>(null);
  let deleteSessionId = $state<string | null>(null);
  let railEl = $state<HTMLDivElement | null>(null);
  let trackEl = $state<HTMLDivElement | null>(null);
  let insertLineEl = $state<HTMLDivElement | null>(null);

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
    // A lift that moved the chip ends with the browser's click on that chip.
    if (suppressChipClick) {
      suppressChipClick = false;
      return;
    }
    if (mobileActionsSessionId === sessionId) {
      mobileActionsSessionId = null;
      return;
    }

    mobileActionsSessionId = null;
    switchToSession(sessionId);
  }

  /* ---------- chip reorder ---------- */

  interface ChipDrag {
    chip: HTMLElement;
    id: string;
    index: number;
    startX: number;
    startScroll: number;
    /** Rail extent past the lift position; measured before any transform so a
     *  moved chip cannot widen the scroll area under the drag. */
    maxExtra: number;
    scrollDelta: number;
    velocity: number;
    boxes: ChipBox[];
    gap: number;
    step: number;
    pointerX: number;
    frame: number | null;
  }

  interface ChipPointer {
    pointerId: number;
    mouse: boolean;
    chip: HTMLElement | null;
    startX: number;
    startY: number;
    moved: boolean;
    mode: ChipGesture;
    panBaseX: number;
    panBaseScroll: number;
  }

  let drag: ChipDrag | null = null;
  let pointer: ChipPointer | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let flowBaseX = 0;
  let flowLeftover = 0;
  let flowChanged = false;
  let suppressChipClick = false;

  function chipElements(): HTMLElement[] {
    if (!trackEl) return [];
    return [...trackEl.querySelectorAll<HTMLElement>('[data-session-chip]')];
  }

  function chipBoxes(elements: HTMLElement[]): ChipBox[] {
    const origin = trackEl?.getBoundingClientRect().left ?? 0;
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left - origin, width: rect.width };
    });
  }

  function clearHoldTimer() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function lift(chip: HTMLElement, startX: number) {
    const elements = chipElements();
    const index = elements.indexOf(chip);
    if (!railEl || !trackEl || index < 0) return;
    const boxes = chipBoxes(elements);
    const gap = boxes.length > 1 ? Math.max(SESSION_CHIP_GAP, boxes[1].left - (boxes[0].left + boxes[0].width)) : SESSION_CHIP_GAP;
    drag = {
      chip,
      id: chip.dataset.sessionChip ?? '',
      index,
      startX,
      startScroll: railEl.scrollLeft,
      maxExtra: Math.max(0, railEl.scrollWidth - railEl.clientWidth - railEl.scrollLeft),
      scrollDelta: 0,
      velocity: 0,
      boxes,
      gap,
      step: boxes[index].width + gap,
      pointerX: startX,
      frame: null,
    };
    chip.classList.remove('session-chip-held');
    chip.classList.add('session-chip-dragging');
    updateDrag(startX);
    startDragLoop();
  }

  function updateDrag(clientX: number) {
    if (!drag || !railEl || !trackEl) return;
    drag.pointerX = clientX;
    const offset = clientX - drag.startX + drag.scrollDelta;
    trackEl.style.transform = drag.scrollDelta ? `translateX(${-drag.scrollDelta}px)` : '';
    drag.chip.style.transform = `translateX(${offset}px) scale(1.06)`;
    const slot = dropSlot(drag.boxes, drag.index, offset);
    chipElements().forEach((element, index) => {
      if (index === drag!.index) return;
      const shift = chipShift(index, drag!.index, slot, drag!.step);
      element.style.transform = shift ? `translateX(${shift}px)` : '';
    });
    if (insertLineEl) {
      // The marker sits in the rail's content space, beside the lifted chip's
      // original slot.
      insertLineEl.style.left = `${insertLineX(drag.boxes, drag.index, slot, drag.gap)}px`;
      insertLineEl.hidden = false;
    }
    const box = railEl.getBoundingClientRect();
    drag.velocity = autoScrollVelocity(clientX, box.left, box.right);
  }

  function startDragLoop() {
    if (!drag || drag.frame !== null) return;
    const tick = () => {
      if (!drag) return;
      if (drag.velocity && railEl) {
        const next = Math.min(drag.maxExtra, Math.max(-drag.startScroll, drag.scrollDelta + drag.velocity));
        if (next !== drag.scrollDelta) {
          drag.scrollDelta = next;
          updateDrag(drag.pointerX);
        }
      }
      drag.frame = requestAnimationFrame(tick);
    };
    drag.frame = requestAnimationFrame(tick);
  }

  function clearDragVisuals() {
    for (const element of chipElements()) {
      element.style.transform = '';
      element.classList.remove('session-chip-dragging');
    }
    if (trackEl) trackEl.style.transform = '';
    if (insertLineEl) insertLineEl.hidden = true;
  }

  /** Put a lifted chip back where it was — the gesture was refused or taken. */
  function cancelDrag() {
    if (!drag) return;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    clearDragVisuals();
    if (railEl) railEl.scrollLeft = drag.startScroll;
    drag = null;
  }

  function dropDrag() {
    if (!drag) return;
    const { id, startScroll, scrollDelta, frame } = drag;
    if (frame !== null) cancelAnimationFrame(frame);
    // The drop slot was measured while the order stood still; the lifted chip's
    // current position is the order's own.
    const fromIndex = sessionRegistry.activeSessions.findIndex((session) => session.sessionId === id);
    const target = drag.boxes.length > 0 ? dropSlot(drag.boxes, drag.index, drag.pointerX - drag.startX + drag.scrollDelta) : fromIndex;
    clearDragVisuals();
    drag = null;
    if (railEl) railEl.scrollLeft = startScroll + scrollDelta;
    if (fromIndex < 0 || fromIndex === target) return;
    suppressChipClick = true;
    sessionRegistry.reorderSessions(fromIndex, target);
  }

  function applyFlowTranslate(offset: number) {
    const anchorId = mobileActionsSessionId;
    for (const element of chipElements()) {
      if (element.dataset.sessionChip === anchorId) {
        element.style.transform = '';
        continue;
      }
      element.style.transform = offset ? `translateX(${offset}px)` : '';
    }
  }

  /** Pin the tray's chip at the rail centre and lay the others out around it. */
  function layoutFlow(ids: string[], anchorId: string) {
    if (!railEl || !trackEl) return;
    const elements = chipElements();
    const anchor = ids.indexOf(anchorId);
    if (elements.length === 0 || anchor < 0) return;
    const rects = elements.map((element) => element.getBoundingClientRect());
    const widths = rects.map((rect) => rect.width || 80);
    const heights = rects.map((rect) => rect.height);
    const rowHeight = Math.max(...heights, 0);
    const anchorX = Math.max(2, Math.round((railEl.clientWidth - widths[anchor]) / 2));
    const positions = new Array<number>(widths.length);
    positions[anchor] = anchorX;
    let x = anchorX - SESSION_CHIP_GAP;
    for (let i = anchor - 1; i >= 0; i--) {
      x -= widths[i];
      positions[i] = x;
      x -= SESSION_CHIP_GAP;
    }
    x = anchorX + widths[anchor] + SESSION_CHIP_GAP;
    for (let i = anchor + 1; i < widths.length; i++) {
      positions[i] = x;
      x += widths[i] + SESSION_CHIP_GAP;
    }
    trackEl.style.height = `${rowHeight}px`;
    elements.forEach((element, index) => {
      element.classList.add('session-chip-flow');
      element.style.left = `${positions[index]}px`;
      element.style.top = `${Math.max(0, (rowHeight - heights[index]) / 2)}px`;
      element.style.zIndex = index === anchor ? '4' : '1';
    });
  }

  function clearFlowLayout() {
    for (const element of chipElements()) {
      element.classList.remove('session-chip-flow');
      element.style.left = '';
      element.style.top = '';
      element.style.zIndex = '';
      element.style.transform = '';
    }
    if (trackEl) trackEl.style.height = '';
  }

  function stepFlow(clientX: number) {
    const anchorId = mobileActionsSessionId;
    if (!anchorId) return;
    const ids = sessionRegistry.activeSessions.map((session) => session.sessionId);
    const index = ids.indexOf(anchorId);
    if (index < 0) return;
    const widthById = new Map(chipElements().map((element) => [element.dataset.sessionChip ?? '', element.getBoundingClientRect().width || 80]));
    const step = flowPasses({
      index,
      count: ids.length,
      deltaX: clientX - flowBaseX,
      widthAt: (position) => widthById.get(ids[position] ?? '') ?? 80,
    });
    flowBaseX = clientX - step.leftover;
    if (step.passes > 0 && step.index !== index) {
      flowChanged = true;
      sessionRegistry.moveSession(index, step.index);
    }
    const direction = step.leftover < 0 ? 1 : -1;
    const blocked = step.index + direction < 0 || step.index + direction >= ids.length;
    flowLeftover = blocked ? flowResistance(step.leftover) : step.leftover;
    applyFlowTranslate(flowLeftover);
  }

  function endFlow() {
    flowLeftover = 0;
    applyFlowTranslate(0);
    if (!flowChanged) return;
    flowChanged = false;
    sessionRegistry.pushSessionOrder();
  }

  function railPointerGesture(node: HTMLDivElement): () => void {
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = event.target;
      const chip = target instanceof Element ? target.closest<HTMLElement>('[data-session-chip]') : null;
      clearHoldTimer();
      suppressChipClick = false;
      const captureNode = chip ?? node;
      try {
        captureNode.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers cannot be captured.
      }
      pointer = {
        pointerId: event.pointerId,
        mouse: event.pointerType === 'mouse',
        chip,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        mode: resolveChipGesture({ trayOpen: !!mobileActionsSessionId, moved: false, deltaX: 0, deltaY: 0 }),
        panBaseX: event.clientX,
        panBaseScroll: node.scrollLeft,
      };
      // A hold does nothing reorder-related while the tray is open, and a
      // mouse needs no hold at all: moving it lifts the chip.
      if (!chip || mobileActionsSessionId || event.pointerType === 'mouse') return;
      chip.classList.add('session-chip-held');
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!pointer || pointer.moved || !pointer.chip) return;
        lift(pointer.chip, pointer.startX);
      }, SESSION_CHIP_HOLD_MS);
    };

    const onMove = (event: PointerEvent) => {
      if (drag) {
        updateDrag(event.clientX);
        return;
      }
      if (!pointer || event.pointerId !== pointer.pointerId) return;
      const deltaX = event.clientX - pointer.startX;
      const deltaY = event.clientY - pointer.startY;
      if (!pointer.moved) {
        if (Math.hypot(deltaX, deltaY) <= SESSION_CHIP_SLOP) return;
        pointer.moved = true;
        clearHoldTimer();
        pointer.chip?.classList.remove('session-chip-held');
        // A mouse needs no hold: moving it with a chip under the cursor lifts.
        if (pointer.mouse && pointer.chip && !mobileActionsSessionId) {
          lift(pointer.chip, pointer.startX);
          updateDrag(event.clientX);
          return;
        }
        pointer.mode = resolveChipGesture({ trayOpen: !!mobileActionsSessionId, moved: true, deltaX, deltaY });
        if (pointer.mode === 'flow') {
          flowBaseX = pointer.startX + Math.sign(deltaX) * SESSION_CHIP_SLOP;
          flowChanged = false;
          flowLeftover = 0;
        } else if (pointer.mode === 'scroll') {
          pointer.panBaseX = event.clientX;
          pointer.panBaseScroll = node.scrollLeft;
        }
      }
      if (pointer.mode === 'scroll') {
        node.scrollLeft = pointer.panBaseScroll - (event.clientX - pointer.panBaseX);
      } else if (pointer.mode === 'flow') {
        stepFlow(event.clientX);
      }
    };

    const onUp = (event: PointerEvent) => {
      clearHoldTimer();
      if (drag) {
        pointer = null;
        dropDrag();
        return;
      }
      if (!pointer || event.pointerId !== pointer.pointerId) {
        pointer = null;
        return;
      }
      pointer.chip?.classList.remove('session-chip-held');
      const chipId = pointer.chip?.dataset.sessionChip;
      if (pointer.mode === 'flow') {
        endFlow();
      } else if (chipId && shouldOpenSessionPillActions(event.clientX - pointer.startX, event.clientY - pointer.startY)) {
        // Upward swipe: the tray opens for this chip, and the tray is what
        // makes the reorder flow live.
        markSwipeHintSeen();
        openMobileActions(chipId);
      }
      pointer = null;
    };

    const onCancel = () => {
      clearHoldTimer();
      pointer?.chip?.classList.remove('session-chip-held');
      cancelDrag();
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
      clearHoldTimer();
    };
  }

  // The context menu asks for a stiller hold than a lift does. When it opens,
  // the gesture belongs to the menu, so a lifted chip goes back.
  $effect(() => {
    if (!openContextMenuSessionId) return;
    clearHoldTimer();
    cancelDrag();
  });

  // The tray decides the mechanic: with it open the tray's chip pins at the
  // rail centre and the row flows around it; with it closed the rail renders
  // as one flat row that a hold-and-drag can reorder.
  $effect(() => {
    const trayId = mobileActionsSessionId;
    const ids = sessionRegistry.activeSessions.map((session) => session.sessionId);
    if (!railEl || !trackEl) return;
    if (trayId && ids.includes(trayId)) {
      layoutFlow(ids, trayId);
      applyFlowTranslate(flowLeftover);
    } else {
      clearFlowLayout();
    }
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
                style="touch-action: none;"
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

        <div class="session-chip-insert-line" bind:this={insertLineEl} hidden></div>
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

  /* A hold lifted this chip: it follows the pointer and the others shift
     aside while the drop slot holds an insert line. */
  :global(.session-chip-held) {
    box-shadow: 0 0 0 2px var(--chart-2);
  }

  :global(.session-chip-dragging) {
    position: relative;
    z-index: 6;
    box-shadow: 0 10px 24px var(--shadow-color);
    transition: box-shadow 160ms ease;
  }

  /* Tray open: the tray's chip pins at the rail centre and the rest are laid
     out around it, gliding when a pass swaps neighbours. */
  :global(.session-chip-flow) {
    position: absolute;
    transition: left 160ms ease;
    will-change: left;
  }

  .session-rail-flow {
    overflow: hidden;
  }

  .session-chip-insert-line {
    position: absolute;
    top: 6px;
    z-index: 7;
    width: 3px;
    height: 22px;
    border-radius: 2px;
    background: var(--chart-2);
    box-shadow: 0 0 8px color-mix(in oklab, var(--chart-2) 80%, transparent);
    pointer-events: none;
  }

  .session-chip-insert-line[hidden] {
    display: none;
  }
</style>
