<script lang="ts">
  import { untrack } from 'svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { commandStore } from '$lib/stores/command-store.svelte.js';
  import { editorTextRequest, setEditorText } from '$lib/stores/input-bar.svelte.js';
  import CommandAutocomplete from './CommandAutocomplete.svelte';
  import type { CommandInfo } from '@pimote/shared';
  import Send from '@lucide/svelte/icons/send';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';

  let inputText = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let autocompleteRef: CommandAutocomplete | undefined = $state();

  const noSession = $derived(sessionRegistry.viewedSessionId === null);
  const canSend = $derived(!noSession && connection.ready);

  // Autocomplete state
  let autocompleteVisible = $state(false);
  let autocompleteMode: 'command' | 'args' = $state('command');
  let selectedCommand: CommandInfo | null = $state(null);

  const commandItems = $derived(commandStore.getCommands(sessionRegistry.viewedSessionId ?? ''));

  const autocompleteQuery = $derived.by(() => {
    if (!autocompleteVisible) return '';
    const text = inputText;
    if (!text.startsWith('/')) return '';
    const afterSlash = text.slice(1);
    const spaceIndex = afterSlash.indexOf(' ');
    if (spaceIndex === -1) {
      // No space — command mode
      return afterSlash;
    }
    // Space present — args mode (query is text after space)
    return afterSlash.slice(spaceIndex + 1);
  });

  // Restore draft text when switching sessions.
  // Tracks viewedSessionId; reads draftText untracked so keystrokes don't re-trigger.
  $effect(() => {
    const _sessionId = sessionRegistry.viewedSessionId;
    inputText = untrack(() => sessionRegistry.viewed?.draftText ?? '');
    autoResize();
  });

  let lastSeq = 0;
  $effect(() => {
    const { sessionId, text, seq } = editorTextRequest;
    if (seq !== lastSeq) {
      lastSeq = seq;
      // Only update the live textarea if the request targets the currently viewed session
      if (sessionId === sessionRegistry.viewedSessionId) {
        inputText = text;
        autoResize();
      }
    }
  });

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.overflow = 'hidden';
    textareaEl.style.height = 'auto';
    const capped = Math.min(textareaEl.scrollHeight, 200);
    textareaEl.style.height = `${capped}px`;
    // Only allow scrolling when content exceeds the cap
    textareaEl.style.overflow = textareaEl.scrollHeight > 200 ? 'auto' : 'hidden';
  }

  function handleInput() {
    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = inputText;
    }

    // Slash detection
    if (inputText.startsWith('/')) {
      if (!autocompleteVisible) {
        autocompleteVisible = true;
        autocompleteMode = 'command';
        selectedCommand = null;
      }

      // Parse mode from input text
      const afterSlash = inputText.slice(1);
      const spaceIndex = afterSlash.indexOf(' ');
      if (spaceIndex === -1) {
        // No space — command mode
        autocompleteMode = 'command';
      } else if (selectedCommand?.hasArgCompletions) {
        // Space present and selected command has arg completions — args mode
        autocompleteMode = 'args';
      } else {
        // Space present but no arg completions — dismiss
        autocompleteVisible = false;
        selectedCommand = null;
      }
    } else {
      autocompleteVisible = false;
      selectedCommand = null;
    }

    autoResize();
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || !canSend) return;

    if (sessionRegistry.viewed?.isStreaming) {
      // Steer the current generation
      sessionRegistry.viewed.pendingSteeringMessages.push(text);
      try {
        await connection.send({
          type: 'steer',
          sessionId: sessionRegistry.viewed.sessionId,
          message: text,
        });
      } catch (e) {
        console.error('Failed to send steer:', e);
      }
    } else {
      // Send a new prompt
      try {
        await connection.send({
          type: 'prompt',
          sessionId: sessionRegistry.viewed!.sessionId,
          message: text,
        });
      } catch (e) {
        console.error('Failed to send prompt:', e);
      }
    }

    inputText = '';
    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = '';
    }
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }
  }

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

    // Restore any queued steering/follow-up messages to the editor (matches TUI behavior).
    // Without this, queued messages stay in the SDK and get silently sent with the next prompt.
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

  function handleAutocompleteSelect(item: { name: string; value?: string; label?: string; description?: string }) {
    if (autocompleteMode === 'command') {
      inputText = '/' + item.name + ' ';
      selectedCommand = commandItems.find((c) => c.name === item.name) ?? null;
      if (selectedCommand?.hasArgCompletions) {
        autocompleteVisible = true;
        autocompleteMode = 'args';
      } else {
        autocompleteVisible = false;
      }
    } else {
      // Args mode
      inputText = '/' + (selectedCommand?.name ?? '') + ' ' + (item.value ?? item.name);
      autocompleteVisible = false;
      selectedCommand = null;
    }
    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = inputText;
    }
    autoResize();
  }

  function handleAutocompleteDismiss() {
    autocompleteVisible = false;
    selectedCommand = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    // Intercept keys when autocomplete is visible
    if (autocompleteVisible && autocompleteRef) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteRef.moveUp();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteRef.moveDown();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        autocompleteRef.accept();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        autocompleteRef.dismiss();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<div class="border-border bg-background shrink-0 border-t px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
  <div class="mx-auto flex max-w-3xl items-end gap-2">
    <!-- Abort button (visible only when streaming) -->
    {#if sessionRegistry.viewed?.isStreaming}
      <button
        class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
        onpointerdown={(e) => e.preventDefault()}
        onclick={handleAbort}
        title="Abort"
      >
        <OctagonX class="size-4" />
        <span class="hidden sm:inline">Abort</span>
      </button>
    {/if}

    <!-- Textarea with autocomplete -->
    <div class="relative flex-1">
      <CommandAutocomplete
        bind:this={autocompleteRef}
        items={commandItems}
        query={autocompleteQuery}
        visible={autocompleteVisible}
        mode={autocompleteMode}
        sessionId={sessionRegistry.viewedSessionId ?? ''}
        commandName={selectedCommand?.name ?? ''}
        onselect={handleAutocompleteSelect}
        ondismiss={handleAutocompleteDismiss}
      />
      <textarea
        bind:this={textareaEl}
        bind:value={inputText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        disabled={noSession}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : sessionRegistry.viewed?.isStreaming ? 'Steer the conversation…' : 'Send a message…'}
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border px-4 py-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      ></textarea>
    </div>

    <!-- Send / Steer button -->
    <button
      class="mb-1 flex shrink-0 items-center justify-center rounded-xl p-2.5 text-sm font-medium transition-colors
				{!canSend || !inputText.trim()
        ? 'bg-secondary text-muted-foreground cursor-not-allowed opacity-50'
        : sessionRegistry.viewed?.isStreaming
          ? 'bg-status-streaming text-primary-foreground hover:bg-status-streaming/80 active:bg-status-streaming/70'
          : 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'}"
      onpointerdown={(e) => e.preventDefault()}
      onclick={sendMessage}
      disabled={!canSend || !inputText.trim()}
      title={sessionRegistry.viewed?.isStreaming ? 'Steer' : 'Send'}
    >
      {#if sessionRegistry.viewed?.isStreaming}
        <MessageSquare class="size-5" />
      {:else}
        <Send class="size-5" />
      {/if}
    </button>
  </div>
</div>
