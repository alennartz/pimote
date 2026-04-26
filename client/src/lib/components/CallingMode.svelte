<script lang="ts">
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { voiceCallStore, getRemoteAudioLevel } from '$lib/stores/voice-call-store.js';
  import { getSessionDisplayName } from '$lib/session-summary.js';
  import { deriveAgentState } from './call-state.js';
  import CallHeader from './CallHeader.svelte';
  import CallGestureZone from './CallGestureZone.svelte';
  import MessageList from './MessageList.svelte';

  // Sample remote audio level at 100ms (10Hz) — matches the analyser rate
  // wired through `voice-call-seams.ts`.
  let remoteAudioLevel = $state(0);
  $effect(() => {
    const id = setInterval(() => {
      remoteAudioLevel = getRemoteAudioLevel();
    }, 100);
    return () => clearInterval(id);
  });

  let viewed = $derived(sessionRegistry.viewed);
  let agentState = $derived(
    deriveAgentState({
      isStreaming: !!viewed?.isStreaming,
      remoteAudioLevel,
      speakingThreshold: 0.02,
    }),
  );

  let folderPath = $derived(viewed?.folderPath ?? null);
  let sessionDisplayName = $derived(getSessionDisplayName(viewed ?? null));
</script>

<div class="bg-background text-foreground fixed inset-0 z-40 flex flex-col">
  <CallHeader {sessionDisplayName} {folderPath} startedAt={voiceCallStore.state.startedAt} micMuted={voiceCallStore.state.micMuted} {agentState} {remoteAudioLevel} />

  <div class="min-h-0 flex-1 overflow-hidden">
    <MessageList readOnly />
  </div>

  <CallGestureZone />
</div>
