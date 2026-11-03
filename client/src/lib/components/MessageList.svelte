<script lang="ts">
  import { tick, onDestroy, onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import type { GetTreeResponseData, PimoteAgentMessage, StreamingMessage, AssistantRowUsage } from '@pimote/shared';
  import { indexToolResultUsage, summarizeAssistantRowUsage } from '$lib/assistant-row-usage.js';
  import type { BashExecutionState, PerSessionState } from '$lib/stores/session-registry.svelte.js';
  import { abortSession, sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { branchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import { abandonedBranchCounts } from '$lib/branch-tree.js';
  import { findInConversation, type FindMatch } from '$lib/conversation-find.js';
  import { previousUserAbove, type UserMessagePosition } from '$lib/transcript-navigation.js';
  import { StickToBottom } from '$lib/stick-to-bottom.svelte.js';
  import { needsDraftPrompt, applyDraftChoice, type DraftChoice } from '$lib/draft-policy.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Message from './Message.svelte';
  import StickyUserPreview from './StickyUserPreview.svelte';
  import ConversationFindBar from './ConversationFindBar.svelte';
  import BashExecution from './BashExecution.svelte';
  import StreamingIndicator from './StreamingIndicator.svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import OctagonX from '@lucide/svelte/icons/octagon-x';

  interface Props {
    /** When true, disables pointer interaction on rendered messages and
     *  suppresses the draft-conflict dialog. Visual rendering and
     *  auto-scroll are unchanged. Default: false. */
    readOnly?: boolean;
    /** Message source to render. Defaults to the viewed regular session;
     *  the manager chat passes its own transcript instead. Redo and the
     *  floating abort are session-only affordances and are disabled for an
     *  explicit source. */
    source?: PerSessionState | null;
  }
  let { readOnly = false, source = null }: Props = $props();

  // The rendered transcript: an explicit source (manager) or the viewed session.
  let session = $derived(source ?? sessionRegistry.viewed);
  // Manager sessions use the regular session route, so identify them from the
  // server-owned manager root as well as explicit manager sources.
  let managerTranscript = $derived(
    Boolean(
      session &&
      ((connection.managerRoot !== null && session.folderPath === connection.managerRoot) || session.projectName === 'manager' || session.folder?.persona?.name === 'manager'),
    ),
  );

  // ---- Transcript redo and draft flow ----

  let draftDialogOpen = $state(false);
  let draftDialogResolve: ((choice: DraftChoice) => void) | null = $state(null);

  function promptDraftChoice(): Promise<DraftChoice> {
    return new Promise<DraftChoice>((resolve) => {
      draftDialogResolve = resolve;
      draftDialogOpen = true;
    });
  }

  function resolveDraft(choice: DraftChoice) {
    draftDialogResolve?.(choice);
    draftDialogResolve = null;
    draftDialogOpen = false;
  }

  async function handleRedo(entryId: string, opts?: { compactionPrompt?: string }) {
    // Redo is a regular-session action. Manager and read-only transcripts have
    // no writable branch tree.
    if (readOnly || source || managerTranscript) return;
    const viewed = sessionRegistry.viewed;
    const sessionId = viewed?.sessionId;
    if (!sessionId) return;

    const result = await branchTreeStore.navigateInSession(sessionId, entryId, opts);
    if (!result || result.cancelled || typeof result.editorText !== 'string') return;

    const currentDraft = sessionRegistry.sessions[sessionId]?.draftText ?? '';
    const editorText = result.editorText;
    if (needsDraftPrompt(currentDraft, editorText)) {
      const choice = await promptDraftChoice();
      const nextText = applyDraftChoice(currentDraft, editorText, choice);
      if (nextText !== null) sessionRegistry.setDraftText(sessionId, nextText);
    } else {
      sessionRegistry.setDraftText(sessionId, editorText);
    }
  }

  function handleAbort() {
    // The manager composer owns abort for an explicit source.
    const sessionId = sessionRegistry.viewedSessionId;
    if (!source && sessionId) void abortSession(sessionId);
  }

  let scrollContainer: HTMLDivElement | undefined = $state();
  let listInner: HTMLDivElement | undefined = $state();

  // Follows the transcript bottom while pinned; escapes on upward user
  // scrolls and re-pins at the bottom. Owns scroll and wheel handling.
  const stick = new StickToBottom({
    scrollElement: () => scrollContainer,
    contentElement: () => listInner,
    initial: 'instant',
    resize: 'instant',
  });

  let treeSnapshot = $state<GetTreeResponseData | null>(null);
  let rowElements = new SvelteMap<string, HTMLElement>();
  let stickyEntryId = $state<string | null>(null);
  let jumpEntryId = $state<string | null>(null);
  let mobileViewport = $state(false);
  let findOpen = $state(false);
  let findQuery = $state('');
  let activeFindMatch = $state<FindMatch | null>(null);
  let findBar: ConversationFindBar | undefined = $state();
  let rowResizeObserver: ResizeObserver | null = null;
  let stickyFrame: number | null = null;
  let listClientWidth = $state<number | null>(null);

  const messageEntryIds = $derived.by(() => {
    const ids = new SvelteMap<string, string>();
    for (const entry of displayEntries) {
      if (entry.kind !== 'message') continue;
      const id = 'entryId' in entry.message && typeof entry.message.entryId === 'string' ? entry.message.entryId : undefined;
      if (id) ids.set(id, entry.key);
    }
    return ids;
  });

  const findMatches = $derived.by(() => {
    if (!findQuery.trim() || !session) return [];
    return findInConversation(session.messages, findQuery.trim());
  });

  const branchCounts = $derived.by(() => (treeSnapshot ? abandonedBranchCounts(treeSnapshot.tree) : new Map<string, number>()));

  function alternateCount(entry: DisplayEntry): number {
    if (entry.kind !== 'message') return 0;
    const id = 'entryId' in entry.message && typeof entry.message.entryId === 'string' ? entry.message.entryId : undefined;
    return id ? (branchCounts.get(id) ?? 0) : 0;
  }

  function registerRow(node: HTMLElement, key: string) {
    rowElements.set(key, node);
    if (!rowResizeObserver && typeof ResizeObserver !== 'undefined') rowResizeObserver = new ResizeObserver(updateStickyTargets);
    rowResizeObserver?.observe(node);
    return {
      destroy() {
        rowResizeObserver?.unobserve(node);
        if (rowElements.get(key) === node) rowElements.delete(key);
      },
    };
  }

  function transcriptPositions(): UserMessagePosition[] {
    const positions: UserMessagePosition[] = [];
    for (const entry of displayEntries) {
      if (entry.kind !== 'message' || entry.message.role !== 'user') continue;
      const node = rowElements.get(entry.key);
      if (!node) continue;
      positions.push({
        entryId: entry.key,
        role: 'user',
        bottom: node.getBoundingClientRect().bottom,
      });
    }
    return positions;
  }

  function updateStickyTargets(): void {
    if (!scrollContainer || stickyFrame !== null) return;
    stickyFrame = requestAnimationFrame(() => {
      stickyFrame = null;
      if (!scrollContainer) return;
      const top = scrollContainer.getBoundingClientRect().top;
      const positions = transcriptPositions();
      // The sticky preview overlays the top of the viewport (~39px tall), so a
      // row is only truly visible once its bottom clears the band it covers.
      stickyEntryId = previousUserAbove(positions, top, 40);
      jumpEntryId = previousUserAbove(positions, top, -4);
    });
  }

  function scrollToEntry(key: string | null): void {
    if (!key) return;
    rowElements.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function closeFind(): void {
    findOpen = false;
    findQuery = '';
    activeFindMatch = null;
  }

  function onFindMatch(match: FindMatch): void {
    activeFindMatch = match;
    const fallbackIndex = match.messageKey.startsWith('message-') ? Number(match.messageKey.slice(8)) : -1;
    const fallbackEntry = fallbackIndex >= 0 ? displayEntries.find((entry) => entry.kind === 'message' && entry.messageIndex === fallbackIndex) : undefined;
    const key = messageEntryIds.get(match.messageKey) ?? fallbackEntry?.key;
    scrollToEntry(key ?? null);
  }

  function isActiveFindEntry(entry: DisplayEntry): boolean {
    if (entry.kind !== 'message' || !activeFindMatch) return false;
    if (activeFindMatch.messageKey === entry.key || ('entryId' in entry.message && activeFindMatch.messageKey === entry.message.entryId)) return true;
    return activeFindMatch.messageKey === `message-${entry.messageIndex ?? -1}`;
  }

  function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      findOpen = true;
      void tick().then(() => findBar?.focusInput());
      return;
    }
    if (event.key === 'Escape' && findOpen) {
      event.preventDefault();
      closeFind();
    }
    // END re-glues a detached scroll viewer to the bottom. Text-entry targets
    // keep the key for caret movement.
    if (event.key === 'End' && !event.ctrlKey && !event.metaKey && !event.altKey && !stick.isAtBottom && !isTextEntryTarget(event.target)) {
      event.preventDefault();
      scrollToBottom();
    }
  }

  $effect(() => {
    const sessionId = session?.sessionId;
    // Message replacement, ordinary turns, and full resync invalidate the tree cache.
    session?.messageCount;
    if (sessionId) branchTreeStore.cacheVersion(sessionId);
    session?.messages.length;
    if (!sessionId || source || readOnly || managerTranscript || !session.messages.some((message) => 'entryId' in message && typeof message.entryId === 'string')) {
      treeSnapshot = null;
      return;
    }
    // Session message count changes after navigation and full resync. `load`
    // returns the cached snapshot until branch-tree lifecycle invalidates it.
    void branchTreeStore.load(sessionId).then((snapshot) => {
      if (sessionRegistry.viewedSessionId === sessionId) treeSnapshot = snapshot;
    });
  });

  $effect(() => {
    // Recompute sticky and jump targets after rows or message layout changes.
    displayEntries.length;
    void tick().then(updateStickyTargets);
  });

  $effect(() => {
    const first = findMatches[0];
    if (!findQuery.trim() || !first) {
      if (!findQuery.trim()) activeFindMatch = null;
      return;
    }
    if (!activeFindMatch || !findMatches.some((match) => match.messageKey === activeFindMatch?.messageKey && match.offset === activeFindMatch.offset)) {
      onFindMatch(first);
    }
  });

  onMount(() => {
    document.addEventListener('keydown', onKeydown);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 640px)') : null;
    const updateMobile = () => (mobileViewport = media?.matches ?? false);
    updateMobile();
    media?.addEventListener?.('change', updateMobile);
    const resize = () => updateStickyTargets();
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('keydown', onKeydown);
      media?.removeEventListener?.('change', updateMobile);
      window.removeEventListener('resize', resize);
    };
  });

  function onScroll() {
    updateStickyTargets();
  }

  type DisplayEntry =
    | { kind: 'message'; key: string; message: PimoteAgentMessage | StreamingMessage; streaming: boolean; messageIndex: number | null }
    | { kind: 'bash'; key: string; execution: BashExecutionState };

  // Unified display entries: finalized messages, streaming message, and the
  // viewed session's transient native bash executions.
  let displayEntries = $derived.by(() => {
    if (!session) return [] as DisplayEntry[];
    const entries: DisplayEntry[] = [];
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      // Hide custom messages with display: false
      if (msg.display === false) continue;
      entries.push({
        kind: 'message',
        key: session.messageKeys[i] ?? `fallback-${i}`,
        message: msg as PimoteAgentMessage | StreamingMessage,
        streaming: false,
        // Keep the source transcript index even when display:false entries are
        // filtered out. The registry uses this index to find persisted usage.
        messageIndex: i,
      });
    }
    if (session.streamingMessage && session.streamingKey) {
      entries.push({
        kind: 'message',
        key: session.streamingKey,
        message: session.streamingMessage,
        streaming: true,
        messageIndex: null,
      });
    }
    for (const execution of Object.values(session.bashExecutions)) {
      entries.push({ kind: 'bash', key: `bash-${execution.id}`, execution });
    }
    return entries;
  });

  let toolResultUsageIndex = $derived.by(() => indexToolResultUsage(session?.messages ?? []));

  function getAssistantRowUsage(entry: Extract<DisplayEntry, { kind: 'message' }>): AssistantRowUsage | null {
    if (entry.message.role !== 'assistant' || !session) return null;
    if (entry.streaming) return summarizeAssistantRowUsage(entry.message, session.messages, toolResultUsageIndex);
    if (entry.messageIndex === null) return null;
    // Explicit sources, such as manager transcripts, are not owned by the
    // regular session registry. Derive their rows directly from their snapshot.
    if (source) return summarizeAssistantRowUsage(entry.message, session.messages, toolResultUsageIndex);
    return sessionRegistry.getAssistantRowUsage(session.sessionId, entry.messageIndex, toolResultUsageIndex);
  }

  // Show streaming indicator when streaming but no content yet
  let showStreamingIndicator = $derived.by(() => {
    if (!session?.isStreaming) return false;
    return !session.streamingMessage || session.streamingMessage.content.length === 0;
  });

  function scrollToBottom() {
    stick.scrollToBottom();
  }

  // Sibling UI (the question panel, the on-screen keyboard) steals height from
  // the list without scrolling it. Re-glue to the bottom on a shrink while
  // pinned, or the leftover offset detaches the follow from the bottom.
  $effect(() => {
    const el = scrollContainer;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = el.clientHeight;
      if (height < lastHeight && stick.isAtBottom) {
        stick.scrollToBottom({ animation: 'instant', preserveScrollPosition: true });
      }
      lastHeight = height;
      listClientWidth = el.clientWidth;
      updateStickyTargets();
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  async function handleBashCancel(_executionId: string): Promise<void> {
    const viewed = sessionRegistry.viewed;
    if (!viewed?.sessionId) return;
    try {
      await connection.send({
        type: 'abort_bash',
        sessionId: viewed.sessionId,
      });
    } catch (error) {
      console.error('Failed to send bash abort:', error);
    }
  }

  // Last bot activity display — auto-updates every 15 seconds
  let now = $state(Date.now());
  const activityInterval = setInterval(() => {
    now = Date.now();
  }, 15_000);
  onDestroy(() => {
    clearInterval(activityInterval);
    if (stickyFrame !== null) cancelAnimationFrame(stickyFrame);
    rowResizeObserver?.disconnect();
    rowResizeObserver = null;
  });

  let lastActivityText = $derived.by(() => {
    // Touch `now` to re-evaluate on timer ticks
    void now;
    if (!session?.lastBotActivityTimestamp) return null;
    // Don't show during active streaming — the streaming indicator is enough
    if (session.isStreaming) return null;
    return formatRelativeTime(session.lastBotActivityTimestamp);
  });
</script>

<div class="message-list-wrapper">
  <div class="message-list" role="region" aria-label="Conversation transcript" bind:this={scrollContainer} onscroll={onScroll}>
    <div class="message-list-inner" class:pointer-events-none={readOnly} bind:this={listInner}>
      {#if displayEntries.length === 0 && !session?.isStreaming}
        <div class="empty-state">
          <p>No messages yet</p>
        </div>
      {/if}

      {#each displayEntries as entry (entry.key)}
        <div class="transcript-row" class:find-active={isActiveFindEntry(entry)} use:registerRow={entry.key} data-message-key={entry.key}>
          {#if entry.kind === 'bash'}
            <BashExecution execution={entry.execution} onCancel={readOnly ? undefined : () => handleBashCancel(entry.execution.id)} />
          {:else}
            {@const assistantRowUsage = getAssistantRowUsage(entry)}
            <Message
              message={entry.message}
              streaming={entry.streaming}
              messageKey={entry.key}
              {assistantRowUsage}
              sessionId={session?.sessionId ?? ''}
              abandonedBranchCount={alternateCount(entry)}
              manager={Boolean(source || managerTranscript)}
              {readOnly}
              store={branchTreeStore}
              onRedo={source || readOnly || managerTranscript ? undefined : handleRedo}
            />
          {/if}
        </div>
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
  {#if !source && !readOnly && !managerTranscript && !mobileViewport && stickyEntryId}
    {@const stickyEntry = displayEntries.find((entry) => entry.kind === 'message' && entry.key === stickyEntryId)}
    {#if stickyEntry && stickyEntry.kind === 'message' && stickyEntry.message.role === 'user' && session?.sessionId}
      {#key stickyEntryId}
        <div class="sticky-host" style={listClientWidth ? `--band-w: ${listClientWidth}px` : undefined}>
          <StickyUserPreview
            message={stickyEntry.message}
            sessionId={session.sessionId}
            abandonedBranchCount={alternateCount(stickyEntry)}
            manager={Boolean(source || managerTranscript)}
            {readOnly}
            store={branchTreeStore}
            onRedo={handleRedo}
            onJump={() => scrollToEntry(stickyEntryId)}
          />
        </div>
      {/key}
    {/if}
  {/if}
  {#if findOpen}
    <div class="findbar-host">
      <ConversationFindBar bind:this={findBar} bind:query={findQuery} matches={findMatches} onMatch={onFindMatch} onClose={closeFind} />
    </div>
  {/if}

  {#if mobileViewport && jumpEntryId}
    <button class="jump-up" onclick={() => scrollToEntry(jumpEntryId)} title="Jump to previous message" aria-label="Jump to previous message">↑</button>
  {/if}

  <!-- Floating abort button (mobile only) -->
  {#if !source && session?.isStreaming && !readOnly}
    <button
      class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 absolute right-3 bottom-3 z-10 flex items-center justify-center rounded-full p-3 shadow-lg transition-colors md:hidden"
      onpointerdown={(e) => e.preventDefault()}
      onclick={handleAbort}
      title="Abort"
    >
      <OctagonX class="size-5" />
    </button>
  {/if}

  <!-- Draft conflict dialog -->
  <Dialog.Root
    open={draftDialogOpen}
    onOpenChange={(open) => {
      if (!open) resolveDraft('ignore');
    }}
  >
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>Draft conflict</Dialog.Title>
        <Dialog.Description>The editor already has text. How should the redone message be combined?</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => resolveDraft('ignore')}>Ignore</Button>
        <Button variant="outline" onclick={() => resolveDraft('prepend')}>Prepend</Button>
        <Button variant="outline" onclick={() => resolveDraft('append')}>Append</Button>
        <Button onclick={() => resolveDraft('replace')}>Replace</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <!-- Scroll to bottom button -->
  {#if !stick.isAtBottom}
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

  /* Spans only the scroll container's client area (scrollbar gutter
     excluded) so the banner centers on the same axis as the chat frame. */
  .sticky-host {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--band-w, 100%);
    z-index: 8;
    pointer-events: none;
  }

  .message-list {
    position: relative;
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: auto;
  }

  .transcript-row {
    position: relative;
    border-radius: 0.4rem;
  }

  .transcript-row.find-active {
    background: color-mix(in oklch, var(--accent) 14%, transparent);
    outline: 1px solid color-mix(in oklch, var(--accent) 45%, transparent);
  }

  .jump-up {
    position: absolute;
    right: 0.75rem;
    bottom: 0.75rem;
    z-index: 10;
    display: none;
    width: 2.4rem;
    height: 2.4rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--secondary);
    color: var(--secondary-foreground);
    box-shadow: 0 2px 8px var(--shadow-color);
    cursor: pointer;
    font-size: 1.2rem;
  }

  @media (max-width: 640px) {
    .jump-up {
      top: 0.75rem;
      display: flex;
      opacity: 0.5;
    }
  }

  .findbar-host {
    position: absolute;
    z-index: 20;
    top: 0;
    right: 0;
    left: 0;
    pointer-events: none;
  }

  .findbar-host :global(.findbar) {
    pointer-events: auto;
    margin-top: 0.5rem;
  }

  .message-list-inner {
    max-width: 884px;
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
    box-shadow: 0 2px 8px var(--shadow-color);
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
</style>
