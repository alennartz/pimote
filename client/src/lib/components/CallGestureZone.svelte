<script lang="ts">
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import { onDestroy } from 'svelte';
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

  // CallingMode (and thus this component) mounts per call; close the cached
  // AudioContext on unmount so contexts don't accumulate across calls and hit
  // the browser's concurrent-AudioContext cap.
  onDestroy(() => {
    cues?.dispose();
    cues = null;
  });

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
      } catch (error) {
        void error;
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
      clearGesture(activePointerId);
      return;
    }
    const target = ev.target as Element;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch (error) {
      void error;
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

  let chevronOffset = $derived(Math.max(-32, Math.min(32, dragDy * 0.4)));

  let muted = $derived(voiceCallStore.state.micMuted);
</script>

<div
  class="relative flex w-full touch-none flex-col items-center justify-between py-3 select-none"
  style="height: min(28vh, 220px); min-height: 160px;"
  role="button"
  tabindex="-1"
  aria-label="Call gesture zone: tap mic to mute, swipe up to hang up, swipe down to abort"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
>
  <div class="text-destructive flex flex-col items-center gap-0.5" style:transform="translateY({chevronOffset}px)">
    <ChevronUp class="-mb-1 size-5 animate-pulse" aria-hidden="true" />
    <div class="border-destructive/40 bg-destructive/10 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tracking-wide">
      <PhoneOff class="size-3.5" aria-hidden="true" />
      <span>Swipe up to hang up</span>
    </div>
  </div>

  <div
    class="relative flex size-16 items-center justify-center rounded-full border-2 transition-colors {muted
      ? 'border-status-reconnecting/60 bg-status-reconnecting/15 text-status-reconnecting'
      : 'border-status-connected/70 bg-status-connected/15 text-status-connected'}"
    aria-label={muted ? 'Microphone muted, tap to unmute' : 'Microphone live, tap to mute'}
  >
    {#if muted}
      <MicOff class="size-7" aria-hidden="true" />
    {:else}
      <Mic class="size-7" aria-hidden="true" />
      <span class="bg-status-connected/20 absolute inset-0 -z-10 animate-ping rounded-full"></span>
    {/if}
  </div>

  <div class="text-status-reconnecting flex flex-col items-center gap-0.5" style:transform="translateY({chevronOffset}px)">
    <div class="border-status-reconnecting/40 bg-status-reconnecting/10 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tracking-wide">
      <OctagonX class="size-3.5" aria-hidden="true" />
      <span>Swipe down to abort</span>
    </div>
    <ChevronDown class="-mt-1 size-5 animate-pulse" aria-hidden="true" />
  </div>
</div>
