<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { commandStore } from '$lib/stores/command-store.svelte.js';
  import { editorTextRequest, setEditorText } from '$lib/stores/input-bar.svelte.js';
  import CommandAutocomplete from './CommandAutocomplete.svelte';
  import type { CommandInfo } from '@pimote/shared';
  import Send from '@lucide/svelte/icons/send';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import X from '@lucide/svelte/icons/x';

  let inputText = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let autocompleteRef: CommandAutocomplete | undefined = $state();

  // Image attachment state
  let stagedImages = $state<string[]>([]);
  let dragOver = $state(false);

  const noSession = $derived(sessionRegistry.viewedSessionId === null);
  const isPending = $derived(sessionRegistry.viewedSessionId?.startsWith('pending-') ?? false);
  const canSend = $derived(!noSession && !isPending && connection.ready);
  const hasContent = $derived(inputText.trim().length > 0 || stagedImages.length > 0);

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
    if (autocompleteMode === 'command') {
      // Command name is everything between / and first space (or end)
      return spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
    }
    // Args mode — query is everything after first space
    return spaceIndex === -1 ? '' : afterSlash.slice(spaceIndex + 1);
  });

  // Restore draft text when switching sessions.
  // Tracks viewedSessionId; reads draftText untracked so keystrokes don't re-trigger.
  $effect(() => {
    const _sessionId = sessionRegistry.viewedSessionId;
    inputText = untrack(() => sessionRegistry.viewed?.draftText ?? '');
    stagedImages = [];
    tick().then(() => autoResize());
  });

  let lastSeq = 0;
  $effect(() => {
    const { sessionId, text, seq } = editorTextRequest;
    if (seq !== lastSeq) {
      lastSeq = seq;
      // Only update the live textarea if the request targets the currently viewed session
      if (sessionId === sessionRegistry.viewedSessionId) {
        inputText = text;
        tick().then(() => autoResize());
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

  // ---------------------------------------------------------------------------
  // Image paste / drag-and-drop
  // ---------------------------------------------------------------------------

  function addImageFiles(files: Iterable<File>) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        stagedImages = [...stagedImages, reader.result as string];
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index: number) {
    stagedImages = stagedImages.filter((_, i) => i !== index);
  }

  function handlePaste(e: ClipboardEvent) {
    if (!canSend) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      addImageFiles(imageFiles);
      // Prevent default only when clipboard has images but no text —
      // e.g. a screenshot paste. If text is also present, let it insert normally.
      if (!e.clipboardData?.types.includes('text/plain')) {
        e.preventDefault();
      }
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (!canSend) return;
    const files = e.dataTransfer?.files;
    if (files) addImageFiles(Array.from(files));
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (canSend) dragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear when actually leaving the drop zone, not when entering a child element
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
      dragOver = false;
    }
  }

  function updateAutocomplete() {
    if (!inputText.startsWith('/') || !textareaEl) {
      autocompleteVisible = false;
      selectedCommand = null;
      return;
    }

    const cursorPos = textareaEl.selectionStart;
    const afterSlash = inputText.slice(1);
    const spaceIndex = afterSlash.indexOf(' ');
    const commandEnd = spaceIndex === -1 ? afterSlash.length : spaceIndex;

    if (cursorPos <= commandEnd + 1) {
      // Cursor is within the command-name part (between / and first space)
      if (!autocompleteVisible) selectedCommand = null;
      autocompleteVisible = true;
      autocompleteMode = 'command';
    } else if (selectedCommand?.hasArgCompletions) {
      autocompleteVisible = true;
      autocompleteMode = 'args';
    } else {
      autocompleteVisible = false;
      selectedCommand = null;
    }
  }

  function handleInput(e?: Event) {
    // When / is typed as the first char with existing text after it, insert a space separator
    if (e && textareaEl) {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertText' && ie.data === '/' && textareaEl.selectionStart === 1 && inputText.length > 1 && inputText[1] !== ' ') {
        inputText = '/ ' + inputText.slice(1);
        if (sessionRegistry.viewed) sessionRegistry.viewed.draftText = inputText;
        tick().then(() => {
          textareaEl!.selectionStart = textareaEl!.selectionEnd = 1;
        });
      }
    }

    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = inputText;
    }
    updateAutocomplete();
    autoResize();
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!canSend) return;

    let sent = false;

    if (sessionRegistry.viewed?.isStreaming) {
      // Steer the current generation (text only, no images)
      if (!text) return;
      sessionRegistry.viewed.pendingSteeringMessages.push(text);
      try {
        await connection.send({
          type: 'steer',
          sessionId: sessionRegistry.viewed.sessionId,
          message: text,
        });
        sent = true;
      } catch (e) {
        console.error('Failed to send steer:', e);
      }
    } else {
      // Send a new prompt (text and/or images)
      if (!text && stagedImages.length === 0) return;
      try {
        await connection.send({
          type: 'prompt',
          sessionId: sessionRegistry.viewed!.sessionId,
          message: text,
          ...(stagedImages.length > 0 ? { images: stagedImages } : {}),
        });
        sent = true;
        // Show the user message immediately instead of waiting for the server event
        sessionRegistry.addOptimisticUserMessage(sessionRegistry.viewed!.sessionId, text);
      } catch (e) {
        console.error('Failed to send prompt:', e);
      }
    }

    if (!sent) return;

    inputText = '';
    stagedImages = [];
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

  function insertSlash() {
    if (!textareaEl) return;
    const start = textareaEl.selectionStart ?? inputText.length;
    const end = textareaEl.selectionEnd ?? start;
    const after = inputText.slice(end);
    const needsSpace = start === 0 && after.length > 0 && after[0] !== ' ';
    inputText = inputText.slice(0, start) + '/' + (needsSpace ? ' ' : '') + after;
    const cursorPos = start + 1;
    if (sessionRegistry.viewed) {
      sessionRegistry.viewed.draftText = inputText;
    }
    handleInput();
    autoResize();
    textareaEl.focus();
    // Place cursor after the inserted slash
    tick().then(() => {
      textareaEl!.selectionStart = textareaEl!.selectionEnd = cursorPos;
    });
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

    if (e.key === 'Escape' && sessionRegistry.viewed?.isStreaming) {
      e.preventDefault();
      handleAbort();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<div class="border-border bg-background relative shrink-0 border-t px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
  <div class="mx-auto flex max-w-3xl items-end gap-2">
    <!-- Abort button (desktop only, visible when streaming) -->
    {#if sessionRegistry.viewed?.isStreaming}
      <button
        class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 mb-1 hidden shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors md:flex"
        onpointerdown={(e) => e.preventDefault()}
        onclick={handleAbort}
        title="Abort"
      >
        <OctagonX class="size-4" />
        <span class="hidden sm:inline">Abort</span>
      </button>
    {/if}

    <!-- Slash shortcut button (mobile only) -->
    {#if !noSession && !inputText.startsWith('/')}
      <button
        class="text-muted-foreground bg-secondary border-border hover:bg-accent active:bg-accent/70 flex shrink-0 items-center justify-center rounded-lg border px-3 py-3 transition-colors md:hidden"
        onpointerdown={(e) => e.preventDefault()}
        onclick={insertSlash}
        title="Slash commands"
      >
        <span class="text-sm leading-5 font-bold">/</span>
      </button>
    {/if}

    <!-- Textarea with autocomplete + image drop zone -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="relative flex-1" ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop}>
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

      <!-- Staged image previews -->
      {#if stagedImages.length > 0}
        <div class="mb-1 flex flex-wrap gap-1.5">
          {#each stagedImages as src, i (i)}
            <div class="group relative">
              <img {src} alt="Staged" class="border-border h-16 w-16 rounded-lg border object-cover" />
              <button
                class="bg-background/80 text-foreground hover:bg-destructive hover:text-destructive-foreground border-border absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm transition-colors"
                onclick={() => removeImage(i)}
                title="Remove image"
              >
                <X class="size-3" />
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <textarea
        bind:this={textareaEl}
        bind:value={inputText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={updateAutocomplete}
        onpaste={handlePaste}
        disabled={noSession || isPending}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : isPending ? 'Starting session…' : sessionRegistry.viewed?.isStreaming ? 'Steer the conversation…' : 'Send a message…'}
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50
          {dragOver ? 'ring-ring ring-2' : ''}"
      ></textarea>

      <!-- Send / Steer button (inset in textarea) -->
      <button
        class="absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-lg p-1.5 text-sm font-medium transition-colors
          {!canSend || (sessionRegistry.viewed?.isStreaming ? !inputText.trim() : !hasContent)
          ? 'text-muted-foreground cursor-not-allowed opacity-50'
          : sessionRegistry.viewed?.isStreaming
            ? 'bg-status-streaming text-primary-foreground hover:bg-status-streaming/80 active:bg-status-streaming/70'
            : 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'}"
        onpointerdown={(e) => e.preventDefault()}
        onclick={sendMessage}
        disabled={!canSend || (sessionRegistry.viewed?.isStreaming ? !inputText.trim() : !hasContent)}
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
</div>
