<script lang="ts">
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import { formatCallDuration, type AgentState } from './call-state.js';
  import CallStateRow from './CallStateRow.svelte';

  interface Props {
    sessionDisplayName: string | null;
    folderPath: string | null;
    /** Epoch ms when the call became 'connected'. Null while still connecting. */
    startedAt: number | null;
    micMuted: boolean;
    agentState: AgentState;
    remoteAudioLevel: number;
  }

  let { sessionDisplayName, folderPath, startedAt, micMuted, agentState, remoteAudioLevel }: Props = $props();

  // Tick once per second so the duration display stays current. The
  // dependency on `startedAt` is read only to compute the elapsed; the
  // setInterval keeps `now` fresh.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  let elapsedMs = $derived(startedAt ? now - startedAt : 0);
  let durationText = $derived(formatCallDuration(elapsedMs));

  // Project label: basename of folderPath if available.
  let projectLabel = $derived.by(() => {
    if (!folderPath) return 'session';
    const trimmed = folderPath.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || 'session';
  });

  let sessionLabel = $derived(sessionDisplayName ?? 'Session');
</script>

<div class="flex flex-col gap-2 px-4 pt-6 pb-3">
  <div class="text-muted-foreground truncate text-xs">
    {projectLabel} · {sessionLabel}
  </div>
  <div class="text-foreground text-3xl tabular-nums">
    {durationText}
  </div>
  <div class="text-muted-foreground flex items-center gap-2 text-sm">
    {#if micMuted}
      <MicOff class="size-4" aria-hidden="true" />
      <span>Muted</span>
    {:else}
      <Mic class="size-4" aria-hidden="true" />
      <span>Live</span>
    {/if}
  </div>
  <CallStateRow state={agentState} {remoteAudioLevel} />
</div>
