<script lang="ts">
  import { tick } from 'svelte';
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import Message from './Message.svelte';
  import StreamingIndicator from './StreamingIndicator.svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';

  let scrollContainer: HTMLDivElement | undefined = $state();
  let userScrolledUp = $state(false);
  let autoScrollEnabled = $state(true);

  // Track whether user has scrolled away from bottom
  function onScroll() {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    // Consider "at bottom" if within 80px
    const atBottom = distanceFromBottom < 80;
    userScrolledUp = !atBottom;
    autoScrollEnabled = atBottom;
  }

  // Unified display entries: finalized messages + streaming message
  let displayEntries = $derived.by(() => {
    const session = sessionRegistry.viewed;
    if (!session) return [];
    const entries: { key: string; message: PimoteAgentMessage | StreamingMessage; streaming: boolean }[] = session.messages.map((msg, i) => ({
      key: session.messageKeys[i] ?? `fallback-${i}`,
      message: msg as PimoteAgentMessage | StreamingMessage,
      streaming: false,
    }));
    if (session.streamingMessage && session.streamingKey) {
      entries.push({
        key: session.streamingKey,
        message: session.streamingMessage,
        streaming: true,
      });
    }
    return entries;
  });

  // Show streaming indicator when streaming but no content yet
  let showStreamingIndicator = $derived.by(() => {
    const session = sessionRegistry.viewed;
    if (!session?.isStreaming) return false;
    return !session.streamingMessage || session.streamingMessage.content.length === 0;
  });

  // Auto-scroll when new content arrives
  $effect(() => {
    // Track display entries changes
    displayEntries.length;
    // Track streaming content changes for auto-scroll
    const session = sessionRegistry.viewed;
    const sm = session?.streamingMessage;
    if (sm && sm.content.length > 0) {
      sm.content.length;
      sm.content[sm.content.length - 1].text;
    }

    if (autoScrollEnabled && scrollContainer) {
      tick().then(() => {
        if (scrollContainer && autoScrollEnabled) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  function scrollToBottom() {
    if (scrollContainer) {
      autoScrollEnabled = true;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }
</script>

<div class="message-list-wrapper">
  <div class="message-list" bind:this={scrollContainer} onscroll={onScroll}>
    <div class="message-list-inner">
      {#if displayEntries.length === 0 && !sessionRegistry.viewed?.isStreaming}
        <div class="empty-state">
          <p>No messages yet</p>
        </div>
      {/if}

      {#each displayEntries as entry (entry.key)}
        <Message message={entry.message} streaming={entry.streaming} />
      {/each}

      <!-- Streaming indicator (agent is working but no content yet) -->
      {#if showStreamingIndicator}
        <div class="streaming-indicator-row">
          <StreamingIndicator />
        </div>
      {/if}
    </div>
  </div>

  <!-- Scroll to bottom button -->
  {#if userScrolledUp}
    <button class="scroll-to-bottom" onclick={scrollToBottom}>
      <ArrowDown size={18} />
    </button>
  {/if}
</div>

<style>
  .message-list-wrapper {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .message-list {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: auto;
  }

  .message-list-inner {
    max-width: 768px;
    margin: 0 auto;
    padding: 16px 16px 24px;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 16px;
    color: var(--muted-foreground);
    font-size: 0.9rem;
  }

  .streaming-indicator-row {
    padding: 4px 0 4px 38px;
  }

  .scroll-to-bottom {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--secondary);
    color: var(--secondary-foreground);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 8px oklch(0 0 0 / 0.3);
    transition:
      background-color 0.15s,
      transform 0.15s;
    z-index: 10;
  }

  .scroll-to-bottom:hover {
    background: var(--accent);
    transform: translateX(-50%) scale(1.05);
  }

  .scroll-to-bottom:active {
    transform: translateX(-50%) scale(0.95);
  }
</style>
