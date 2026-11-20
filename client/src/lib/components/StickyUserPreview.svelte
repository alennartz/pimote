<script lang="ts">
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import type { BranchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import MessageActionMenu from './MessageActionMenu.svelte';
  import User from '@lucide/svelte/icons/user';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';

  interface Props {
    message: PimoteAgentMessage | StreamingMessage;
    sessionId: string;
    abandonedBranchCount?: number;
    manager?: boolean;
    readOnly?: boolean;
    store?: Pick<BranchTreeStore, 'navigate' | 'openFocused'>;
    onRedo?: (entryId: string, opts?: { compactionPrompt?: string }) => void | Promise<void>;
    onFork?: (entryId: string) => void | Promise<void>;
    onJump?: () => void;
  }

  let { message, sessionId, abandonedBranchCount = 0, manager = false, readOnly = false, store, onRedo, onFork, onJump }: Props = $props();
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
    <span class="avatar-anchor">
      <button type="button" class="avatar" aria-label="Message actions" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
        <User size={15} />
      </button>
      {#if menuOpen}
        <div class="menu-pop">
          <MessageActionMenu open {entryId} {sessionId} {abandonedBranchCount} {manager} {readOnly} {store} {onRedo} {onFork} onClose={() => (menuOpen = false)} />
        </div>
      {/if}
    </span>
    <span class="line" title={text}>{text.split('\n')[0]}</span>
    <button type="button" class="jump" aria-label="Jump to previous message" title="Jump to previous message" onclick={() => onJump?.()}>
      <ArrowUp size={15} />
    </button>
  </div>
{/if}

<style>
  /* Centers within .sticky-host, which spans the scroll container's client
     area, so this aligns with the chat frame (min(884px, 100%) minus its
     16px inner padding). Takes no flow space, so appearing and disappearing
     never shifts the rows underneath. */
  .sticky-preview {
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: min(852px, 100% - 32px);
    min-height: 2.25rem;
    padding: 0.3rem 0.45rem;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 0.4rem 0.4rem;
    background: color-mix(in oklch, var(--background) 94%, transparent);
    backdrop-filter: blur(5px);
    pointer-events: auto;
  }

  .avatar-anchor {
    position: relative;
    flex: 0 0 auto;
  }

  .avatar {
    display: inline-flex;
    width: 1.7rem;
    height: 1.7rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: var(--avatar-bg);
    color: var(--avatar-fg);
    cursor: pointer;
  }

  .menu-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 9;
    padding: 0.3rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: color-mix(in oklch, var(--background) 96%, transparent);
    backdrop-filter: blur(5px);
    box-shadow: 0 2px 8px var(--shadow-color);
  }

  .line {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
  }

  .jump {
    display: inline-flex;
    width: 1.7rem;
    height: 1.7rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: var(--secondary);
    color: var(--secondary-foreground);
    cursor: pointer;
  }

  .jump:hover,
  .avatar:hover {
    filter: brightness(1.1);
  }

  @media (max-width: 640px) {
    .sticky-preview {
      display: none;
    }
  }
</style>
