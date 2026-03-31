<script lang="ts">
  import { tick } from 'svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import Message from './Message.svelte';
  import TextBlock from './TextBlock.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
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

  // Auto-scroll when new content arrives
  $effect(() => {
    // Access reactive deps to trigger on changes.
    // Read .length / Object.keys so Svelte tracks array/object mutations,
    // not just property-reference changes.
    sessionRegistry.viewed?.messages.length;
    sessionRegistry.viewed?.streamingMessage?.content.length;
    // Track text changes in the last streaming block for auto-scroll
    const sm = sessionRegistry.viewed?.streamingMessage;
    if (sm && sm.content.length > 0) sm.content[sm.content.length - 1].text;

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

  // Derived: do we have any streaming content to show?
  // Derive streaming text and thinking from streamingMessage for rendering
  let streamingText = $derived.by(() => {
    const sm = sessionRegistry.viewed?.streamingMessage;
    if (!sm) return '';
    return sm.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  });
  let streamingThinking = $derived.by(() => {
    const sm = sessionRegistry.viewed?.streamingMessage;
    if (!sm) return '';
    return sm.content
      .filter((b) => b.type === 'thinking')
      .map((b) => b.text ?? '')
      .join('');
  });
  let hasStreamingContent = $derived((sessionRegistry.viewed?.isStreaming ?? false) && (streamingText.length > 0 || streamingThinking.length > 0));
</script>

<div class="message-list-wrapper">
  <div class="message-list" bind:this={scrollContainer} onscroll={onScroll}>
    <div class="message-list-inner">
      {#if (sessionRegistry.viewed?.messages ?? []).length === 0 && !sessionRegistry.viewed?.isStreaming}
        <div class="empty-state">
          <p>No messages yet</p>
        </div>
      {/if}

      {#each sessionRegistry.viewed?.messages ?? [] as message, i (i)}
        <Message {message} />
      {/each}

      <!-- Streaming content (in-progress) -->
      {#if hasStreamingContent}
        <div class="message assistant-message streaming">
          <div class="streaming-body">
            {#if streamingThinking}
              <ThinkingBlock text={streamingThinking} streaming={true} />
            {/if}

            {#if streamingText}
              <TextBlock text={streamingText} streaming={true} />
            {/if}
          </div>
        </div>
      {/if}

      <!-- Streaming indicator (agent is working but no content yet) -->
      {#if sessionRegistry.viewed?.isStreaming && !hasStreamingContent}
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

  .streaming {
    display: flex;
    gap: 10px;
    padding: 12px 0;
  }

  .streaming-body {
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
    /* Give left margin to align with assistant message bodies (icon width + gap) */
    margin-left: 38px;
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
