<script lang="ts">
  import Phone from '@lucide/svelte/icons/phone';
  import { voiceCallStore } from '$lib/stores/voice-call-store.js';

  interface Props {
    sessionId?: string;
  }

  let { sessionId }: Props = $props();

  let disabled = $derived.by(() => {
    if (!sessionId) return true;
    const s = voiceCallStore.state;
    if (s.phase === 'idle') return false;
    return s.sessionId !== sessionId;
  });

  function onClick() {
    if (!sessionId || disabled) return;
    voiceCallStore.startCall(sessionId).catch((err) => {
      console.warn('[voice] startCall failed', err);
    });
  }
</script>

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
