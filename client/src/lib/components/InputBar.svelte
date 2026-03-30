<script lang="ts">
  import { untrack } from 'svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { editorTextRequest } from '$lib/stores/input-bar.svelte.js';
  import Send from '@lucide/svelte/icons/send';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';

  let inputText = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  const disabled = $derived(sessionRegistry.viewedSessionId === null);

  // Restore draft text when switching sessions.
  // Tracks viewedSessionId; reads draftText untracked so keystrokes don't re-trigger.
  $effect(() => {
    const _sessionId = sessionRegistry.viewedSessionId;
    inputText = untrack(() => sessionRegistry.viewed?.draftText ?? '');
    autoResize();
  });

  let lastSeq = 0;
  $effect(() => {
    const { text, seq } = editorTextRequest;
    if (seq !== lastSeq) {
      lastSeq = seq;
      inputText = text;
      if (sessionRegistry.viewed) {
        sessionRegistry.viewed.draftText = text;
      }
      autoResize();
    }
  });

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    // Cap at roughly 8 lines
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 200)}px`;
  }

  function handleInput() {
    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = inputText;
    }
    autoResize();
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || disabled) return;

    if (sessionRegistry.viewed?.isStreaming) {
      // Steer the current generation
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
    if (!sessionRegistry.viewed?.sessionId) return;
    try {
      await connection.send({
        type: 'abort',
        sessionId: sessionRegistry.viewed.sessionId,
      });
    } catch (e) {
      console.error('Failed to send abort:', e);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
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
        onclick={handleAbort}
        title="Abort"
      >
        <OctagonX class="size-4" />
        <span class="hidden sm:inline">Abort</span>
      </button>
    {/if}

    <!-- Textarea -->
    <div class="relative flex-1">
      <textarea
        bind:this={textareaEl}
        bind:value={inputText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        {disabled}
        rows={1}
        placeholder={disabled ? 'Open a session to start…' : sessionRegistry.viewed?.isStreaming ? 'Steer the conversation…' : 'Send a message…'}
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none rounded-xl border px-4 py-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      ></textarea>
    </div>

    <!-- Send / Steer button -->
    <button
      class="mb-1 flex shrink-0 items-center justify-center rounded-xl p-2.5 text-sm font-medium transition-colors
				{disabled || !inputText.trim()
        ? 'bg-secondary text-muted-foreground cursor-not-allowed opacity-50'
        : sessionRegistry.viewed?.isStreaming
          ? 'bg-status-streaming text-primary-foreground hover:bg-status-streaming/80 active:bg-status-streaming/70'
          : 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'}"
      onclick={sendMessage}
      disabled={disabled || !inputText.trim()}
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
