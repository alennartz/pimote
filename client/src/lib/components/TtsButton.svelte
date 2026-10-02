<script lang="ts">
  import { toggleTts, speechState } from '$lib/stores/speech.svelte.js';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import VolumeOff from '@lucide/svelte/icons/volume-off';

  let { messageKey, textContent }: { messageKey: string; textContent: string } = $props();

  let playing = $derived(speechState.playingKey === messageKey);
</script>

<button class="tool-btn" onclick={() => toggleTts(messageKey, textContent)} title={playing ? 'Stop audio' : 'Read aloud'}>
  {#if playing}
    <VolumeOff size={14} />
  {:else}
    <Volume2 size={14} />
  {/if}
</button>

<style>
  .tool-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: var(--secondary);
    color: var(--foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .tool-btn:active {
    background: color-mix(in oklch, var(--secondary) 90%, white);
  }
</style>
