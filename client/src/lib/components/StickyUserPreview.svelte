<script lang="ts">
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import type { BranchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import MessageActionMenu from './MessageActionMenu.svelte';
  import User from '@lucide/svelte/icons/user';

  interface Props {
    message: PimoteAgentMessage | StreamingMessage;
    sessionId: string;
    abandonedBranchCount?: number;
    manager?: boolean;
    readOnly?: boolean;
    store?: Pick<BranchTreeStore, 'navigate' | 'openFocused'>;
    onRedo?: (entryId: string, opts?: { compactionPrompt?: string }) => void | Promise<void>;
  }

  let { message, sessionId, abandonedBranchCount = 0, manager = false, readOnly = false, store, onRedo }: Props = $props();
  let menuOpen = $state(false);

  let entryId = $derived('entryId' in message && typeof message.entryId === 'string' ? message.entryId : '');
  let text = $derived(
    message.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('\n\n'),
  );
</script>

{#if entryId}
  <div class="sticky-preview">
    <button type="button" class="avatar" aria-label="Message actions" onclick={() => (menuOpen = !menuOpen)}>
      <User size={15} />
    </button>
    <span class="line" title={text}>{text.split('\n')[0]}</span>
    <span class="chip">previous message</span>
    <MessageActionMenu open={menuOpen} {entryId} {sessionId} {abandonedBranchCount} {manager} {readOnly} {store} {onRedo} onClose={() => (menuOpen = false)} />
  </div>
{/if}

<style>
  .sticky-preview {
    position: sticky;
    top: 0;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.25rem;
    margin: 0 0.5rem;
    padding: 0.3rem 0.45rem;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 0.4rem 0.4rem;
    background: color-mix(in oklch, var(--background) 94%, transparent);
    backdrop-filter: blur(5px);
  }

  .avatar {
    display: inline-flex;
    width: 1.7rem;
    height: 1.7rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: var(--avatar-bg);
    color: var(--avatar-fg);
    cursor: pointer;
  }

  .line {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
  }

  .chip {
    flex: 0 0 auto;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .sticky-preview {
      display: none;
    }
  }
</style>
