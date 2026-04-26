<script lang="ts">
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import { voiceCallStore } from '$lib/stores/voice-call-store.js';

  interface Props {
    sessionId?: string;
    /** Visual treatment.
     *  - `inline` (default): compact 6×6 muted icon used by the desktop StatusBar.
     *    Always behaves as a Start-only button (legacy behaviour preserved).
     *  - `dialog-row`: wider labelled button used inside SessionSettingsDialog.
     *    Toggles between green Start call / red End call. */
    variant?: 'inline' | 'dialog-row';
  }

  let { sessionId, variant = 'inline' }: Props = $props();

  let inCall = $derived.by(() => {
    if (!sessionId) return false;
    const s = voiceCallStore.state;
    return s.phase !== 'idle' && s.sessionId === sessionId;
  });

  let disabled = $derived.by(() => {
    if (!sessionId) return true;
    const s = voiceCallStore.state;
    if (s.phase === 'idle') return false;
    // Allow ending a call bound to this session; disallow when another
    // session owns the call.
    return s.sessionId !== sessionId;
  });

  function onClick() {
    if (!sessionId || disabled) return;
    if (variant === 'dialog-row' && inCall) {
      voiceCallStore.endCall().catch((err) => {
        console.warn('[voice] endCall failed', err);
      });
      return;
    }
    voiceCallStore.startCall(sessionId).catch((err) => {
      console.warn('[voice] startCall failed', err);
    });
  }
</script>

{#if variant === 'inline'}
  <button
    type="button"
    class="text-muted-foreground hover:text-foreground inline-flex size-6 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    title="Start voice call"
    aria-label="Start voice call"
    onclick={onClick}
    {disabled}
  >
    <Phone class="size-3.5" />
  </button>
{:else}
  <button
    type="button"
    class="inline-flex h-9 min-w-32 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 {inCall
      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      : 'bg-emerald-500/90 text-white hover:bg-emerald-500'}"
    title={inCall ? 'End voice call' : 'Start voice call'}
    aria-label={inCall ? 'End voice call' : 'Start voice call'}
    onclick={onClick}
    {disabled}
  >
    {#if inCall}
      <PhoneOff class="size-4" />
      <span>End call</span>
    {:else}
      <Phone class="size-4" />
      <span>Start call</span>
    {/if}
  </button>
{/if}
