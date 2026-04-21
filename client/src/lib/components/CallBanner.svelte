<script lang="ts">
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import { voiceCallStore } from '$lib/stores/voice-call-store.js';

  let state = $derived(voiceCallStore.state);
  let visible = $derived(state.phase !== 'idle');

  let phaseLabel = $derived.by(() => {
    switch (state.phase) {
      case 'binding':
        return 'Connecting…';
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return state.micMuted ? 'On call — muted' : 'On call';
      case 'ending':
        return 'Ending call…';
      default:
        return '';
    }
  });

  function onToggleMute() {
    voiceCallStore.toggleMute();
  }
  function onHangup() {
    voiceCallStore.endCall().catch((err) => console.warn('[voice] endCall failed', err));
  }
</script>

{#if visible}
  <div class="flex items-center gap-2 border-b border-emerald-800 bg-emerald-950/80 px-3 py-1.5 text-xs text-emerald-50" role="status" aria-live="polite">
    <span class="relative flex size-2">
      <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
      <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
    </span>
    <span class="flex-1 truncate">{phaseLabel}</span>
    {#if state.lastError}
      <span class="max-w-xs truncate text-red-300" title={state.lastError}>{state.lastError}</span>
    {/if}
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded bg-emerald-800/60 px-2 py-0.5 transition-colors hover:bg-emerald-700"
      onclick={onToggleMute}
      title={state.micMuted ? 'Unmute microphone' : 'Mute microphone'}
      aria-label={state.micMuted ? 'Unmute' : 'Mute'}
    >
      {#if state.micMuted}
        <MicOff class="size-3.5" />
        <span>Unmute</span>
      {:else}
        <Mic class="size-3.5" />
        <span>Mute</span>
      {/if}
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded bg-red-700/80 px-2 py-0.5 transition-colors hover:bg-red-600"
      onclick={onHangup}
      title="End call"
      aria-label="End call"
    >
      <PhoneOff class="size-3.5" />
      <span>Hang up</span>
    </button>
  </div>
{/if}
