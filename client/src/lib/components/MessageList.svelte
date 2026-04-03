<script lang="ts">
  import { tick, onDestroy } from 'svelte';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { setEditorText } from '$lib/stores/input-bar.svelte.js';
  import Message from './Message.svelte';
  import SwipeReveal from './SwipeReveal.svelte';
  import StreamingIndicator from './StreamingIndicator.svelte';
  import { speak, stop, speechState } from '$lib/stores/speech.svelte.js';
  import { markdownToSpeech } from '$lib/markdown-to-speech.js';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Square from '@lucide/svelte/icons/square';

  async function handleAbort() {
    const session = sessionRegistry.viewed;
    if (!session?.sessionId) return;
    try {
      await connection.send({
        type: 'abort',
        sessionId: session.sessionId,
      });
    } catch (e) {
      console.error('Failed to send abort:', e);
    }

    if (session.pendingSteeringMessages.length > 0) {
      try {
        const res = await connection.send({
          type: 'dequeue_steering',
          sessionId: session.sessionId,
        });
        if (res.success && res.data) {
          const { steering, followUp } = res.data as { steering: string[]; followUp: string[] };
          const allQueued = [...steering, ...followUp];
          if (allQueued.length > 0) {
            setEditorText(session.sessionId, allQueued.join('\n'));
          }
        }
      } catch (e) {
        console.error('Failed to dequeue steering messages after abort:', e);
      }
      session.pendingSteeringMessages = [];
    }
  }

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

  // --- TTS swipe-to-reveal ---

  // Track which SwipeReveal is currently open (only one at a time)
  let openSwipeKey: string | null = $state(null);
  let swipeRefs: Record<string, SwipeReveal | undefined> = {};

  function isSwipeable(entry: (typeof displayEntries)[number]): boolean {
    return entry.message.role === 'assistant' && !entry.streaming && entry.message.content.some((c) => c.type === 'text' && c.text);
  }

  function handleTtsToggle(entry: (typeof displayEntries)[number]) {
    if (speechState.playingKey === entry.key) {
      stop();
    } else {
      const textContent = entry.message.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n\n');
      const speakable = markdownToSpeech(textContent);
      if (speakable) {
        speak(speakable, entry.key);
      }
    }
  }

  function handleSwipeOpen(key: string) {
    if (openSwipeKey && openSwipeKey !== key) {
      swipeRefs[openSwipeKey]?.close();
    }
    openSwipeKey = key;
  }

  function handleSwipeClose(key: string) {
    if (openSwipeKey === key) {
      openSwipeKey = null;
    }
    if (speechState.playingKey === key) {
      stop();
    }
  }

  // Last bot activity display — auto-updates every 15 seconds
  let now = $state(Date.now());
  const activityInterval = setInterval(() => {
    now = Date.now();
  }, 15_000);
  onDestroy(() => clearInterval(activityInterval));

  let lastActivityText = $derived.by(() => {
    // Touch `now` to re-evaluate on timer ticks
    void now;
    const session = sessionRegistry.viewed;
    if (!session?.lastBotActivityTimestamp) return null;
    // Don't show during active streaming — the streaming indicator is enough
    if (session.isStreaming) return null;
    return formatRelativeTime(session.lastBotActivityTimestamp);
  });
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
        {#if isSwipeable(entry)}
          <SwipeReveal bind:this={swipeRefs[entry.key]} onopen={() => handleSwipeOpen(entry.key)} onclose={() => handleSwipeClose(entry.key)}>
            {#snippet action()}
              <button class="tts-action-btn" onclick={() => handleTtsToggle(entry)}>
                {#if speechState.playingKey === entry.key}
                  <Square size={20} />
                {:else}
                  <Volume2 size={20} />
                {/if}
              </button>
            {/snippet}
            <Message message={entry.message} streaming={entry.streaming} />
          </SwipeReveal>
        {:else}
          <Message message={entry.message} streaming={entry.streaming} />
        {/if}
      {/each}

      <!-- Streaming indicator (agent is working but no content yet) -->
      {#if showStreamingIndicator}
        <div class="streaming-indicator-row">
          <StreamingIndicator />
        </div>
      {/if}

      {#if lastActivityText}
        <div class="last-activity">
          {lastActivityText}
        </div>
      {/if}
    </div>
  </div>

  <!-- Floating abort button (mobile only) -->
  {#if sessionRegistry.viewed?.isStreaming}
    <button
      class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 absolute right-3 bottom-3 z-10 flex items-center justify-center rounded-full p-3 shadow-lg transition-colors md:hidden"
      onpointerdown={(e) => e.preventDefault()}
      onclick={handleAbort}
      title="Abort"
    >
      <OctagonX class="size-5" />
    </button>
  {/if}

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
    overflow-x: hidden;
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

  .last-activity {
    text-align: right;
    font-size: 0.7rem;
    color: var(--muted-foreground);
    opacity: 0.6;
    padding: 4px 4px 0;
  }

  .tts-action-btn {
    position: sticky;
    top: calc(67vh - 20px);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin: 0 auto;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--secondary-foreground);
    cursor: pointer;
  }

  .tts-action-btn:active {
    opacity: 0.7;
  }
</style>
