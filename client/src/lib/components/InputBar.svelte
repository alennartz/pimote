<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { abortSession, sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection, isConnectionLossError } from '$lib/stores/connection.svelte.js';
  import { commandStore } from '$lib/stores/command-store.svelte.js';
  import { consumeSharedImages, editorTextRequest, sharedImagesRequest } from '$lib/stores/input-bar.svelte.js';
  import { treeDialogStore } from '$lib/stores/tree-dialog.svelte.js';
  import { loginStore } from '$lib/stores/login-store.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import CommandAutocomplete from './CommandAutocomplete.svelte';
  import { extractFileRefPrefix, resolveFileRefSelection } from '$lib/file-ref-prefix.js';
  import { parseBangBashCommand } from '$lib/bash-command.js';
  import type { BashResponseData, CommandInfo, PromptResponseData } from '@pimote/shared';
  import Send from '@lucide/svelte/icons/send';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import X from '@lucide/svelte/icons/x';

  let inputText = $state('');
  let messageTextareaEl: HTMLTextAreaElement | undefined = $state();
  let bashTextareaEl: HTMLTextAreaElement | undefined = $state();
  let autocompleteRef: CommandAutocomplete | undefined = $state();

  // Image attachment state
  let stagedImages = $state<string[]>([]);
  let dragOver = $state(false);

  const noSession = $derived(sessionRegistry.viewedSessionId === null);
  const isPending = $derived(sessionRegistry.viewedSessionId?.startsWith('pending-') ?? false);
  const canSend = $derived(!noSession && !isPending && connection.ready);
  const hasContent = $derived(inputText.trim().length > 0 || stagedImages.length > 0);
  // A leading bang switches the composer into shell-command mode. Keep this
  // separate from parsing so the feedback appears as soon as the prefix is
  // typed, including while the command is still incomplete.
  const isBangCommand = $derived(inputText.trimStart().startsWith('!'));
  const textareaEl = $derived(isBangCommand ? bashTextareaEl : messageTextareaEl);

  // Autocomplete state
  let autocompleteVisible = $state(false);
  let autocompleteMode: 'command' | 'args' | 'fileRefs' = $state('command');
  let selectedCommand: CommandInfo | null = $state(null);
  let fileRefPrefix: string | null = $state(null);

  const commandItems = $derived(commandStore.getCommands(sessionRegistry.viewedSessionId ?? ''));

  const autocompleteQuery = $derived.by(() => {
    if (!autocompleteVisible) return '';
    if (autocompleteMode === 'fileRefs') return fileRefPrefix ?? '';
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

  // Initialize from the singleton's current seq: the request store outlives
  // this component, so a fresh mount must only react to requests arriving
  // after mount, never replay a stale one (which would refill the composer
  // with old text).
  let lastSeq = editorTextRequest.seq;
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

  // Pick up images from Web Share Target once a real session is viewed. The
  // request stays global while this composer is absent or ineligible.
  let lastSharedSeq = 0;
  $effect(() => {
    const seq = sharedImagesRequest.seq;
    if (seq === lastSharedSeq || noSession || isPending || !sessionRegistry.viewed) return;

    lastSharedSeq = seq;
    const images = consumeSharedImages();
    if (images.length > 0) {
      stagedImages = [...stagedImages, ...images];
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
    if (!textareaEl) {
      autocompleteVisible = false;
      selectedCommand = null;
      fileRefPrefix = null;
      return;
    }

    // `@`-file-path completion takes priority and works mid-line, so it is
    // checked before the slash gate and is cursor-relative.
    const textBeforeCursor = inputText.slice(0, textareaEl.selectionStart);
    const at = extractFileRefPrefix(textBeforeCursor);
    if (at !== null) {
      autocompleteVisible = true;
      autocompleteMode = 'fileRefs';
      fileRefPrefix = at;
      selectedCommand = null;
      return;
    }
    fileRefPrefix = null;

    if (!inputText.startsWith('/')) {
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

  // Svelte's textarea typings omit Safari's non-standard autocorrect attr.
  // Both editing hosts are initialized before either can receive focus.
  $effect(() => {
    bashTextareaEl?.setAttribute('autocorrect', 'off');
    messageTextareaEl?.removeAttribute('autocorrect');
  });

  function focusTextarea() {
    textareaEl?.focus({ preventScroll: true });
  }

  function captureTextareaFocus() {
    const focused = document.activeElement;
    if (focused !== messageTextareaEl && focused !== bashTextareaEl) return null;
    const element = focused as HTMLTextAreaElement;
    return {
      element,
      cursorPosition: element.selectionStart,
    };
  }

  function restoreTextareaFocus(snapshot: ReturnType<typeof captureTextareaFocus>) {
    if (!snapshot) return;
    void tick().then(() => {
      if (!textareaEl || textareaEl === snapshot.element) return;
      focusTextarea();
      const position = Math.min(snapshot.cursorPosition, textareaEl.value.length);
      textareaEl.selectionStart = textareaEl.selectionEnd = position;
      autoResize();
    });
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
    restoreTextareaFocus(captureTextareaFocus());
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!canSend) return;
    const focusSnapshot = captureTextareaFocus();

    function clearSubmittedComposer(sessionId: string, preserveImages = false): void {
      inputText = '';
      autocompleteVisible = false;
      selectedCommand = null;
      fileRefPrefix = null;
      if (!preserveImages) stagedImages = [];
      if (sessionRegistry.viewedSessionId === sessionId) {
        sessionRegistry.sessions[sessionId]!.draftText = '';
      }
      if (messageTextareaEl) messageTextareaEl.style.height = 'auto';
      if (bashTextareaEl) bashTextareaEl.style.height = 'auto';
      restoreTextareaFocus(focusSnapshot);
    }

    function restoreSubmittedComposer(sessionId: string, draft: string, images: string[], clientMessageId?: string, preserveImages = false): void {
      const session = sessionRegistry.sessions[sessionId];
      if (!session || session.draftText !== '') return;
      // A later optimistic prompt owns the empty composer. Do not put an older
      // failed submission back on top of it.
      if (clientMessageId && session.optimisticEntries.some((entry) => entry.clientMessageId !== clientMessageId)) return;
      const retainedImages = preserveImages && stagedImages.length === images.length && stagedImages.every((image, index) => image === images[index]);
      if (sessionRegistry.viewedSessionId === sessionId && (inputText !== '' || (!preserveImages && stagedImages.length > 0) || (preserveImages && !retainedImages))) return;

      session.draftText = draft;
      if (sessionRegistry.viewedSessionId !== sessionId) return;
      inputText = draft;
      if (!preserveImages) stagedImages = [...images];
      tick().then(() => autoResize());
    }

    // Native bang commands are dispatched before slash commands, steering, or
    // ordinary prompts. They are independent of model streaming and own their
    // caller-generated correlation ID so live output can be reduced correctly.
    const parsedBash = parseBangBashCommand(text);
    if (parsedBash) {
      const session = sessionRegistry.viewed;
      if (!session) return;
      const sessionId = session.sessionId;
      const id = crypto.randomUUID();
      sessionRegistry.startBash(sessionId, {
        id,
        command: parsedBash.command,
        excludeFromContext: parsedBash.excludeFromContext,
      });

      // Clear the submitted draft immediately. Staged images intentionally stay
      // attached to the next prompt; bang commands never consume prompt images.
      inputText = '';
      autocompleteVisible = false;
      selectedCommand = null;
      fileRefPrefix = null;
      if (sessionRegistry.viewed?.sessionId === sessionId) {
        sessionRegistry.viewed.draftText = '';
      }
      if (textareaEl) {
        textareaEl.style.height = 'auto';
      }
      restoreTextareaFocus(focusSnapshot);

      try {
        const response = await connection.send({
          type: 'bash',
          id,
          sessionId,
          command: parsedBash.command,
          excludeFromContext: parsedBash.excludeFromContext,
        });
        const data = response.data as BashResponseData | undefined;
        if (response.success && data?.result) {
          sessionRegistry.completeBash(sessionId, id, data.result);
        } else {
          sessionRegistry.failBash(sessionId, id, response.error ?? 'Bash command failed');
        }
      } catch (error) {
        if (isConnectionLossError(error)) {
          // The server may have accepted and started the command before the
          // socket dropped. Keep the transient execution running and
          // cancellable; reconnect recovery will replace it from session data
          // rather than dispatching the command again.
          console.warn('Bash command outcome unknown after connection loss; awaiting reconnect:', error);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sessionRegistry.failBash(sessionId, id, message);
          console.error('Failed to send bash command:', error);
        }
      }
      return;
    }

    // Intercept the bare `/login` and `/logout` commands client-side: open the
    // providers dialog instead of sending a prompt to the agent. Both open the
    // same picker — tap a provider to log in, tap "Log out" to sign out.
    if (text === '/login' || text === '/logout') {
      void loginStore.open();
      inputText = '';
      autocompleteVisible = false;
      selectedCommand = null;
      if (sessionRegistry.viewed) {
        sessionRegistry.viewed.draftText = '';
      }
      if (textareaEl) {
        textareaEl.style.height = 'auto';
      }
      restoreTextareaFocus(focusSnapshot);
      return;
    }

    // Intercept `/compact` — triggers manual context compaction with optional
    // custom instructions (e.g. `/compact focus on file diffs and decisions`).
    if (/^\/compact(?:\s|$)/.test(text)) {
      const originatingSessionId = sessionRegistry.viewed?.sessionId;
      if (!originatingSessionId) return;
      const submittedDraft = inputText;
      const customInstructions = text.slice('/compact'.length).trim() || undefined;
      try {
        const response = await connection.send({
          type: 'compact',
          sessionId: originatingSessionId,
          customInstructions,
        });
        if (!response.success) {
          console.error('Compact rejected:', response.error);
          return;
        }

        const originatingSession = sessionRegistry.sessions[originatingSessionId];
        if (originatingSession?.draftText === submittedDraft) {
          originatingSession.draftText = '';
        }
        if (!originatingSession || sessionRegistry.viewedSessionId !== originatingSessionId || inputText !== submittedDraft) return;

        inputText = '';
        autocompleteVisible = false;
        selectedCommand = null;
        if (textareaEl) textareaEl.style.height = 'auto';
        restoreTextareaFocus(focusSnapshot);
      } catch (e) {
        console.error('Failed to compact:', e);
      }
      return;
    }

    if (sessionRegistry.viewed?.isStreaming) {
      // Steer the current generation with text and staged images. Image-only
      // steering stays disabled because this branch requires text.
      if (!text) return;
      const sessionId = sessionRegistry.viewed.sessionId;
      const submittedDraft = inputText;
      const submittedImages = [...stagedImages];
      const isSlashCommand = text.startsWith('/');
      // Show the pending pill and clear the submitted draft before the
      // round-trip. Slash input waits for pi's command handling or
      // queue_update: a command may run instead of queueing.
      const showPill = !isSlashCommand;
      if (showPill) sessionRegistry.viewed.pendingSteeringMessages.push(text);
      clearSubmittedComposer(sessionId, isSlashCommand);
      // Remove the pill when pi will not queue the text. A queued text needs
      // no cleanup: pi's queue_update snapshot already replaced the list.
      const dropPill = () => {
        const pending = sessionRegistry.sessions[sessionId]?.pendingSteeringMessages;
        const idx = showPill && pending ? pending.lastIndexOf(text) : -1;
        if (idx !== -1) pending!.splice(idx, 1);
      };
      try {
        const dispatchResponse = isSlashCommand
          ? await connection.send({
              type: 'prompt',
              sessionId,
              message: text,
            })
          : await connection.send({
              type: 'steer',
              sessionId,
              message: text,
              ...(submittedImages.length > 0 ? { images: submittedImages } : {}),
            });
        if (!dispatchResponse.success) {
          dropPill();
          restoreSubmittedComposer(sessionId, submittedDraft, submittedImages, undefined, isSlashCommand);
          console.error(`${isSlashCommand ? 'Prompt' : 'Steer'} rejected:`, dispatchResponse.error);
        } else {
          const promptData = dispatchResponse.data as Record<string, unknown> | undefined;
          if (promptData?.tree) {
            treeDialogStore.openDialog(sessionId, promptData.tree as import('@pimote/shared').PimoteTreeNode[], (promptData.currentLeafId as string) ?? null);
          } else if ((dispatchResponse.data as PromptResponseData | undefined)?.outcome !== 'queued') {
            dropPill();
          }
        }
      } catch (e) {
        dropPill();
        restoreSubmittedComposer(sessionId, submittedDraft, submittedImages, undefined, isSlashCommand);
        console.error('Failed to send steer:', e);
      }
    } else {
      // Send a new prompt (text and/or images)
      if (!text && stagedImages.length === 0) return;
      const sessionId = sessionRegistry.viewed!.sessionId;
      const submittedDraft = inputText;
      const submittedImages = [...stagedImages];
      // Show the user message and clear the submitted draft before the
      // round-trip. Slash input renders on its echo only: extension commands
      // never echo, and skill or template expansion echoes different text.
      const clientMessageId = text.startsWith('/') ? undefined : crypto.randomUUID();
      if (clientMessageId) sessionRegistry.addOptimisticUserMessage(sessionId, text, clientMessageId);
      clearSubmittedComposer(sessionId);
      try {
        const promptResponse = await connection.send({
          type: 'prompt',
          sessionId,
          message: text,
          ...(submittedImages.length > 0 ? { images: submittedImages } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        });
        if (!promptResponse.success) {
          if (clientMessageId) sessionRegistry.dropOptimisticUserMessage(sessionId, clientMessageId);
          restoreSubmittedComposer(sessionId, submittedDraft, submittedImages, clientMessageId);
          console.error('Prompt rejected:', promptResponse.error);
        } else {
          // Handle /tree response — open tree dialog instead of adding a message
          const promptData = promptResponse.data as Record<string, unknown> | undefined;
          if (promptData?.tree) {
            treeDialogStore.openDialog(sessionId, promptData.tree as import('@pimote/shared').PimoteTreeNode[], (promptData.currentLeafId as string) ?? null);
          } else if (clientMessageId && (promptData as PromptResponseData | undefined)?.outcome !== 'started') {
            // Only a started prompt echoes a stamped user message. A queued
            // prompt shows in the steering queue and echoes unstamped later.
            sessionRegistry.dropOptimisticUserMessage(sessionId, clientMessageId);
          }
        }
      } catch (e) {
        if (clientMessageId) sessionRegistry.dropOptimisticUserMessage(sessionId, clientMessageId);
        restoreSubmittedComposer(sessionId, submittedDraft, submittedImages, clientMessageId);
        console.error('Failed to send prompt:', e);
      }
    }
  }

  function handleAbort() {
    const sessionId = sessionRegistry.viewedSessionId;
    if (sessionId) void abortSession(sessionId);
  }

  function handleAutocompleteSelect(item: { name: string; value?: string; label?: string; description?: string }) {
    if (autocompleteMode === 'command') {
      // Replace only the command name portion, preserving any text after it
      const afterSlash = inputText.slice(1);
      const spaceIndex = afterSlash.indexOf(' ');
      const rest = spaceIndex === -1 ? '' : afterSlash.slice(spaceIndex);
      inputText = '/' + item.name + (rest || ' ');
      const cursorPos = 1 + item.name.length + 1; // after "/{name} "
      selectedCommand = commandItems.find((c) => c.name === item.name) ?? null;
      if (selectedCommand?.hasArgCompletions) {
        autocompleteVisible = true;
        autocompleteMode = 'args';
      } else {
        autocompleteVisible = false;
      }
      tick().then(() => {
        if (textareaEl) {
          textareaEl.selectionStart = textareaEl.selectionEnd = cursorPos;
        }
      });
    } else if (autocompleteMode === 'fileRefs') {
      // FileRefs mode — replace the @-token immediately before the cursor
      const cursor = textareaEl?.selectionStart ?? inputText.length;
      const tokenStart = cursor - (fileRefPrefix?.length ?? 0);
      const value = item.value ?? item.name;
      const selection = resolveFileRefSelection(value);
      inputText = inputText.slice(0, tokenStart) + selection.insertedText + inputText.slice(cursor);
      const cursorPos = tokenStart + selection.insertedText.length;
      if (selection.isDirectory) {
        // Directory — keep the menu open so the user can drill in
        autocompleteVisible = true;
        autocompleteMode = 'fileRefs';
        fileRefPrefix = selection.nextPrefix;
      } else {
        autocompleteVisible = false;
      }
      tick().then(() => {
        if (textareaEl) {
          textareaEl.selectionStart = textareaEl.selectionEnd = cursorPos;
        }
      });
    } else {
      // Args mode — replace only up to cursor, preserving any text after it
      const commandName = selectedCommand?.name ?? '';
      const prefix = '/' + commandName + ' ';
      const cursor = textareaEl?.selectionStart ?? inputText.length;
      const rest = cursor < inputText.length ? inputText.slice(cursor) : '';
      const argValue = item.value ?? item.name;
      inputText = prefix + argValue + rest;
      const cursorPos = prefix.length + argValue.length;
      autocompleteVisible = false;
      selectedCommand = null;
      tick().then(() => {
        if (textareaEl) {
          textareaEl.selectionStart = textareaEl.selectionEnd = cursorPos;
        }
      });
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

  function handleWindowKeydown(e: KeyboardEvent) {
    // Textareas handle Escape themselves so autocomplete keeps precedence and
    // the abort command is sent only once. A window listener covers keyboard
    // focus on every other element in the desktop session view.
    if (e.key !== 'Escape' || e.defaultPrevented || isMobileViewport() || treeDialogStore.state.open || loginStore.state.flow !== 'idle' || !sessionRegistry.viewed?.isStreaming)
      return;
    e.preventDefault();
    handleAbort();
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
        e.stopPropagation();
        autocompleteRef.dismiss();
        return;
      }
    }

    if (e.key === 'Escape' && sessionRegistry.viewed?.isStreaming) {
      e.preventDefault();
      e.stopPropagation();
      handleAbort();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

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
        bind:this={messageTextareaEl}
        bind:value={inputText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={updateAutocomplete}
        onpaste={handlePaste}
        disabled={noSession || isPending}
        tabindex={isBangCommand ? -1 : 0}
        aria-hidden={isBangCommand}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : isPending ? 'Starting session…' : sessionRegistry.viewed?.isStreaming ? 'Steer the conversation…' : 'Send a message…'}
        autocapitalize="sentences"
        spellcheck={!isMobileViewport()}
        aria-label="Message"
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm transition-colors focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50
          {isBangCommand ? 'pointer-events-none absolute inset-0 opacity-0' : ''}
          {dragOver ? 'ring-ring ring-2' : ''}"
      ></textarea>

      <textarea
        bind:this={bashTextareaEl}
        bind:value={inputText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={updateAutocomplete}
        onpaste={handlePaste}
        disabled={noSession || isPending}
        tabindex={isBangCommand ? 0 : -1}
        aria-hidden={!isBangCommand}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : isPending ? 'Starting session…' : sessionRegistry.viewed?.isStreaming ? 'Steer the conversation…' : 'Send a message…'}
        autocapitalize="none"
        spellcheck={false}
        aria-label="Bash command"
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm transition-colors focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50
          {isBangCommand
          ? 'border-warning bg-warning/10 focus:border-warning focus:ring-warning font-mono [font-variant-ligatures:none]'
          : 'pointer-events-none absolute inset-0 opacity-0'}
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
