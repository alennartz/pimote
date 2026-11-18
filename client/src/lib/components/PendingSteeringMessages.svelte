<script lang="ts">
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import Undo2 from '@lucide/svelte/icons/undo-2';

  let loading = $state(false);
  const session = $derived(sessionRegistry.viewedConversation);
  const pending = $derived(session?.pendingSteeringMessages ?? []);

  async function dequeue() {
    const sessionId = session?.sessionId;
    if (!sessionId || loading) return;
    loading = true;
    try {
      await sessionRegistry.sendSurfaceCommand(sessionId, { type: 'dequeue_steering' });
    } catch (error) {
      console.error('Failed to dequeue steering messages:', error);
    } finally {
      loading = false;
    }
  }
</script>

{#if pending.length > 0}
  <button
    class="border-border bg-background hover:bg-accent/50 active:bg-accent w-full border-t transition-colors"
    onclick={dequeue}
    disabled={loading}
    title="Pull back pending steering messages for editing"
  >
    <div class="mx-auto flex max-w-3xl items-start gap-2 px-4 py-2">
      <Undo2 class="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        {#each pending as msg, i (i)}
          <p class="text-muted-foreground truncate text-left text-xs">{msg}</p>
        {/each}
      </div>
      <span class="text-muted-foreground/60 mt-0.5 shrink-0 text-[10px]">tap to edit</span>
    </div>
  </button>
{/if}
