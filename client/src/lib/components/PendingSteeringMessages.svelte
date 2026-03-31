<script lang="ts">
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { setEditorText } from '$lib/stores/input-bar.svelte.js';
  import Undo2 from '@lucide/svelte/icons/undo-2';

  let loading = $state(false);

  const pending = $derived(sessionRegistry.viewed?.pendingSteeringMessages ?? []);

  async function dequeue() {
    const session = sessionRegistry.viewed;
    if (!session || loading) return;

    loading = true;
    try {
      const res = await connection.send({
        type: 'dequeue_steering',
        sessionId: session.sessionId,
      });
      if (res.success && res.data) {
        const { steering } = res.data as { steering: string[]; followUp: string[] };
        if (steering.length > 0) {
          setEditorText(session.sessionId, steering.join('\n'));
        }
        session.pendingSteeringMessages = [];
      }
    } catch (e) {
      console.error('Failed to dequeue steering messages:', e);
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
