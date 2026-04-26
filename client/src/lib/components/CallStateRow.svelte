<script lang="ts">
  import type { AgentState } from './call-state.js';

  interface Props {
    state: AgentState;
    /** Inbound audio level 0..1 — drives the speaking pulse. Ignored otherwise. */
    remoteAudioLevel: number;
  }

  let { state, remoteAudioLevel }: Props = $props();

  let speakingScale = $derived(1 + Math.min(1, Math.max(0, remoteAudioLevel)) * 0.6);
  let speakingOpacity = $derived(0.6 + Math.min(1, Math.max(0, remoteAudioLevel)) * 0.4);

  let label = $derived(state);
</script>

<div class="flex items-center gap-2">
  {#if state === 'listening'}
    <span class="dot animate-breathe bg-cyan-400" aria-hidden="true"></span>
  {:else if state === 'thinking'}
    <span class="dot animate-thinking bg-amber-400" aria-hidden="true"></span>
  {:else}
    <span class="dot bg-emerald-400 transition-[transform,opacity] duration-[80ms]" style:transform="scale({speakingScale})" style:opacity={speakingOpacity} aria-hidden="true"
    ></span>
  {/if}
  <span class="text-foreground text-sm font-medium">{label}</span>
</div>

<style>
  .dot {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 9999px;
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
  }
  .animate-breathe {
    animation: breathe 2s ease-in-out infinite;
  }
  @keyframes thinking {
    0%,
    100% {
      opacity: 0.5;
      transform: scale(0.95);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
    }
  }
  .animate-thinking {
    animation: thinking 0.6s ease-in-out infinite;
  }
</style>
