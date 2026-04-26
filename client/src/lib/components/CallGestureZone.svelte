<script lang="ts">
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { voiceCallStore } from '$lib/stores/voice-call-store.js';
  import { createCallAudioCues, type CallAudioCues } from '$lib/call-audio-cues.js';
  import { recognizeCallGesture, type PointerSample } from './call-gesture.js';

  // Lazily instantiated on the first cue so we don't construct an
  // AudioContext before a user gesture has happened.
  let cues: CallAudioCues | null = null;
  function getCues(): CallAudioCues {
    if (!cues) cues = createCallAudioCues();
    return cues;
  }

  let activePointerId = $state<number | null>(null);
  // Element that received setPointerCapture on pointerdown. We must release
  // capture on *that* element — not on a later event's target (which can be a
  // different child under the gesture zone). (review finding #3)
  let captureTarget: Element | null = null;
  let startSample: PointerSample | null = null;
  let dragDy = $state(0);

  function clearGesture(pointerId: number | null) {
    if (captureTarget && pointerId !== null && captureTarget.hasPointerCapture?.(pointerId)) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    }
    captureTarget = null;
    activePointerId = null;
    startSample = null;
    dragDy = 0;
  }

  function onPointerDown(ev: PointerEvent) {
    if (!ev.isPrimary) return;
    if (activePointerId !== null && activePointerId !== ev.pointerId) {
      // Concurrent secondary pointer — cancel the in-flight gesture.
      clearGesture(activePointerId);
      return;
    }
    const target = ev.target as Element;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    captureTarget = target;
    activePointerId = ev.pointerId;
    startSample = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    dragDy = 0;
  }

  function onPointerMove(ev: PointerEvent) {
    if (activePointerId !== ev.pointerId || !startSample) return;
    dragDy = ev.clientY - startSample.y;
  }

  function onPointerUp(ev: PointerEvent) {
    if (activePointerId !== ev.pointerId || !startSample) {
      clearGesture(activePointerId);
      return;
    }
    const end: PointerSample = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    const gesture = recognizeCallGesture(startSample, end);
    clearGesture(ev.pointerId);

    switch (gesture) {
      case 'tap': {
        voiceCallStore.toggleMute();
        const muted = voiceCallStore.state.micMuted;
        try {
          if (muted) getCues().playMuteOn();
          else getCues().playMuteOff();
        } catch (err) {
          console.warn('[voice] mute cue failed', err);
        }
        break;
      }
      case 'swipe-up': {
        voiceCallStore.endCall().catch(() => {});
        break;
      }
      case 'swipe-down': {
        voiceCallStore.abortAgent().catch(() => {});
        try {
          getCues().playAbortConfirm();
        } catch (err) {
          console.warn('[voice] abort cue failed', err);
        }
        break;
      }
      default:
        break;
    }
  }

  function onPointerCancel(ev: PointerEvent) {
    if (activePointerId === ev.pointerId) {
      clearGesture(ev.pointerId);
    }
  }

  // Cosmetic: nudge hint chevrons opposite to finger motion while dragging.
  let chevronOffset = $derived(Math.max(-24, Math.min(24, -dragDy * 0.3)));
</script>

<div
  class="relative w-full touch-none select-none"
  style="height: min(25vh, 200px); min-height: 120px;"
  role="button"
  tabindex="-1"
  aria-label="Call gesture zone: tap to mute, swipe up to hang up, swipe down to abort"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  <div class="text-muted-foreground absolute top-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-0.5 text-xs" style:transform="translate(-50%, {chevronOffset}px)">
    <ChevronUp class="size-5" aria-hidden="true" />
    <span>Hang up</span>
  </div>

  <div class="text-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-base font-medium">
    {voiceCallStore.state.micMuted ? 'Tap to unmute' : 'Tap to mute'}
  </div>

  <div class="text-muted-foreground absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-0.5 text-xs" style:transform="translate(-50%, {chevronOffset}px)">
    <span>Abort</span>
    <ChevronDown class="size-5" aria-hidden="true" />
  </div>
</div>
