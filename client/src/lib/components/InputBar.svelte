<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { abortSession, replaceSessionWithFresh, sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection, isConnectionLossError } from '$lib/stores/connection.svelte.js';
  import { commandStore } from '$lib/stores/command-store.svelte.js';
  import { consumeSharedImages, editorTextRequest, sharedImagesRequest } from '$lib/stores/input-bar.svelte.js';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
  import { branchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import { loginStore } from '$lib/stores/login-store.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import CommandAutocomplete from './CommandAutocomplete.svelte';
  import { extractFileRefPrefix, resolveFileRefSelection } from '$lib/file-ref-prefix.js';
  import { parseBangBashCommand } from '$lib/bash-command.js';
  import { uploadImages } from '$lib/image-upload.js';
  import { caretOnFirstVisualRow, caretOnLastVisualRow } from '$lib/caret-visual-rows.js';
  import type { BashResponseData, CommandInfo, PromptResponseData } from '@pimote/shared';
  import Send from '@lucide/svelte/icons/send';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import X from '@lucide/svelte/icons/x';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';

  let inputText = $state('');
  let messageTextareaEl: HTMLTextAreaElement | undefined = $state();
  let bashTextareaEl: HTMLTextAreaElement | undefined = $state();
  let autocompleteRef: CommandAutocomplete | undefined = $state();
  const uiQueue = getExtensionUiQueue();
  let lastViewedSessionId: string | null | undefined;
  let lastViewedSurfaceKey: string | null | undefined;
  let sessionBeforePending: string | null = null;
  let pendingFocusOrigin: Element | null = null;

  // Image attachment state
  let stagedImages = $state<string[]>([]);
  let dragOver = $state(false);

  const activeChild = $derived(sessionRegistry.viewedSubagentAttachment);
  const conversation = $derived(sessionRegistry.viewedConversation);
  const rootSessionId = $derived(sessionRegistry.viewedSessionId);
  const activeSurfaceKey = $derived(conversation?.sessionId ?? rootSessionId ?? '');
  const noSession = $derived(rootSessionId === null);
  const isPending = $derived(rootSessionId?.startsWith('pending-') ?? false);
  const canSend = $derived(!noSession && !isPending && connection.ready && conversation !== null);
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

  // Prompt history recall (Up/Down). historyStash holds the composer text from
  // before navigation started; null means history mode is inactive.
  let historyStash: string | null = $state(null);

  // The composer owns /new locally, so pi's command stays out of the list —
  // every command shown here still dispatches to the agent.
  const commandItems = $derived(commandStore.getCommands(activeSurfaceKey).filter((command) => command.name !== 'new'));

  // Oldest → newest recall entries: queued steering messages (pending, not yet
  // in the transcript) followed by the surface's transcript user messages.
  // Consecutive duplicates collapse so arrowing through repeated sends works.
  const historyEntries = $derived.by(() => {
    const queued = conversation?.pendingSteeringMessages ?? [];
    const transcript: string[] = [];
    for (const message of conversation?.messages ?? []) {
      if (message.role !== 'user') continue;
      const text = message.content
        .filter((content) => content.type === 'text' && content.text)
        .map((content) => content.text!)
        .join('\n\n');
      if (text.trim().length > 0) transcript.push(text);
    }
    const combined = [...queued, ...transcript];
    return combined.filter((text, index) => index === 0 || text !== combined[index - 1]);
  });

  // Non-null while history recall holds the composer; `older` gates the up
  // chevron (false only when parked on the oldest entry). A down chevron
  // always shows in history mode: newer entries or the stashed draft sit below.
  const historyNavigation = $derived.by(() => {
    if (historyStash === null) return null;
    return { older: historyEntries.lastIndexOf(inputText) !== 0 };
  });

  function setSurfaceDraft(text: string): void {
    if (conversation) sessionRegistry.setDraftText(conversation.sessionId, text, { notify: false });
  }

  function getSurfaceDraft(): string {
    return conversation?.draftText ?? '';
  }

  function surfaceStreaming(): boolean {
    return conversation?.isStreaming ?? false;
  }

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
    const sessionId = sessionRegistry.viewedSessionId;
    const surfaceKey = activeSurfaceKey;
    const previousId = lastViewedSessionId;
    const previousSurfaceKey = lastViewedSurfaceKey;
    lastViewedSessionId = sessionId;
    lastViewedSurfaceKey = surfaceKey;
    inputText = untrack(() => getSurfaceDraft());
    stagedImages = [];
    autocompleteVisible = false;
    selectedCommand = null;
    fileRefPrefix = null;
    historyStash = null;
    tick().then(() => autoResize());

    if (!sessionId) return;
    if (sessionId.startsWith('pending-')) {
      if (!previousId?.startsWith('pending-')) sessionBeforePending = previousId ?? null;
      pendingFocusOrigin = document.activeElement;
      return;
    }

    if (previousId === sessionId && previousSurfaceKey !== surfaceKey) {
      focusOnSessionOpen(surfaceKey, document.activeElement);
    } else if (previousId == null) {
      if (document.activeElement === document.body) focusOnSessionOpen(sessionId, document.activeElement);
    } else if (untrack(() => !!sessionRegistry.sessions[previousId])) {
      focusOnSessionOpen(sessionId, document.activeElement);
    } else if (previousId.startsWith('pending-') && sessionId !== sessionBeforePending) {
      focusOnSessionOpen(sessionId, pendingFocusOrigin);
    }
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
      if (sessionId === conversation?.sessionId) {
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

  function focusOnSessionOpen(sessionId: string, origin: Element | null) {
    if (untrack(isMobileViewport)) return;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== origin) return;

    void tick().then(() => {
      if (
        (sessionRegistry.viewedSessionId !== sessionId && activeSurfaceKey !== sessionId) ||
        untrack(isMobileViewport) ||
        uiQueue.hasRequestForSession(sessionId) ||
        branchTreeStore.state.open ||
        loginStore.state.flow !== 'idle' ||
        document.querySelector('[role="dialog"][aria-modal="true"]:not([data-state="closed"]), [role="alertdialog"][aria-modal="true"]:not([data-state="closed"]), dialog[open]')
      )
        return;
      if (document.activeElement !== document.body && document.activeElement !== focused) return;
      focusTextarea();
    });
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
      if (!textareaEl || textareaEl === snapshot.element || document.activeElement !== snapshot.element) return;
      focusTextarea();
      const position = Math.min(snapshot.cursorPosition, textareaEl.value.length);
      textareaEl.selectionStart = textareaEl.selectionEnd = position;
      autoResize();
    });
  }

  function handleInput(e?: Event) {
    // Editing exits history recall; the edited text wins over the stash.
    historyStash = null;
    // When / is typed as the first char with existing text after it, insert a space separator
    if (e && textareaEl) {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertText' && ie.data === '/' && textareaEl.selectionStart === 1 && inputText.length > 1 && inputText[1] !== ' ') {
        inputText = '/ ' + inputText.slice(1);
        setSurfaceDraft(inputText);
        tick().then(() => {
          textareaEl!.selectionStart = textareaEl!.selectionEnd = 1;
        });
      }
    }

    setSurfaceDraft(inputText);
    updateAutocomplete();
    autoResize();
    restoreTextareaFocus(captureTextareaFocus());
  }

  async function sendMessage() {
    historyStash = null;
    const text = inputText.trim();
    const origin = conversation;
    if (!canSend || !origin) return;
    const sessionId = origin.sessionId;
    const originatingChild = activeChild;
    const focusSnapshot = captureTextareaFocus();
    const send = (command: Record<string, unknown>) => sessionRegistry.sendSurfaceCommand(sessionId, command);
    const isCurrent = () => sessionRegistry.viewedConversation?.sessionId === sessionId;

    function clearSubmittedComposer(preserveImages = false): void {
      sessionRegistry.setDraftText(sessionId, '', { notify: false });
      if (!isCurrent()) return;
      inputText = '';
      autocompleteVisible = false;
      selectedCommand = null;
      fileRefPrefix = null;
      if (!preserveImages) stagedImages = [];
      if (messageTextareaEl) messageTextareaEl.style.height = 'auto';
      if (bashTextareaEl) bashTextareaEl.style.height = 'auto';
      restoreTextareaFocus(focusSnapshot);
    }

    function restoreSubmittedComposer(draft: string, images: string[], clientMessageId?: string, preserveImages = false): void {
      const session = sessionRegistry.getSessionState(sessionId);
      if (!session || session.draftText !== '') return;
      if (clientMessageId && session.optimisticEntries.some((entry) => entry.clientMessageId !== clientMessageId)) return;
      const retainedImages = preserveImages && stagedImages.length === images.length && stagedImages.every((image, index) => image === images[index]);
      if (isCurrent() && (inputText !== '' || (!preserveImages && stagedImages.length > 0) || (preserveImages && !retainedImages))) return;
      sessionRegistry.setDraftText(sessionId, draft);
      if (!isCurrent()) return;
      inputText = draft;
      if (!preserveImages) stagedImages = [...images];
      tick().then(() => autoResize());
    }

    const parsedBash = parseBangBashCommand(text);
    if (parsedBash) {
      const id = crypto.randomUUID();
      sessionRegistry.startBash(sessionId, { id, command: parsedBash.command, excludeFromContext: parsedBash.excludeFromContext });
      clearSubmittedComposer(true);
      try {
        const response = await send({ type: 'bash', id, command: parsedBash.command, excludeFromContext: parsedBash.excludeFromContext });
        const data = response.data as BashResponseData | undefined;
        if (response.success && data?.result) sessionRegistry.completeBash(sessionId, id, data.result);
        else sessionRegistry.failBash(sessionId, id, response.error ?? 'Bash command failed');
      } catch (error) {
        if (isConnectionLossError(error)) {
          console.warn('Bash command outcome unknown after connection loss; awaiting reconnect:', error);
        } else {
          sessionRegistry.failBash(sessionId, id, error instanceof Error ? error.message : String(error));
          console.error('Failed to send bash command:', error);
        }
      }
      return;
    }

    if (!originatingChild && /^\/new(?:\s|$)/.test(text)) {
      clearSubmittedComposer();
      void replaceSessionWithFresh(sessionId);
      return;
    }

    if (!originatingChild && (text === '/login' || text === '/logout')) {
      void loginStore.open();
      clearSubmittedComposer();
      return;
    }

    if (/^\/compact(?:\s|$)/.test(text)) {
      // Compaction can run for a long time; leave the composer immediately and
      // let the transcript's compacting indicator take over. A rejected or
      // failed dispatch restores the text (only while the composer is empty).
      const submittedDraft = inputText;
      const submittedImages = [...stagedImages];
      const customInstructions = text.slice('/compact'.length).trim() || undefined;
      clearSubmittedComposer(true);
      try {
        const response = await send({ type: 'compact', customInstructions });
        if (!response.success) {
          console.error('Compact rejected:', response.error);
          restoreSubmittedComposer(submittedDraft, submittedImages, undefined, true);
        }
      } catch (error) {
        console.error('Failed to compact:', error);
        restoreSubmittedComposer(submittedDraft, submittedImages, undefined, true);
      }
      return;
    }

    if (origin.isStreaming) {
      if (!text) return;
      const submittedDraft = inputText;
      const submittedImages = [...stagedImages];
      const isSlashCommand = text.startsWith('/');
      const showPill = !isSlashCommand;
      if (showPill) origin.pendingSteeringMessages.push(text);
      clearSubmittedComposer(isSlashCommand);
      const dropPill = () => {
        const pending = sessionRegistry.getSessionState(sessionId)?.pendingSteeringMessages;
        const index = showPill && pending ? pending.lastIndexOf(text) : -1;
        if (index !== -1) pending!.splice(index, 1);
      };
      try {
        const imageRefs = isSlashCommand || submittedImages.length === 0 ? [] : await uploadImages(submittedImages);
        const response = isSlashCommand
          ? await send({ type: 'prompt', message: text })
          : await send({ type: 'steer', message: text, ...(imageRefs.length > 0 ? { images: imageRefs } : {}) });
        if (!response.success) {
          dropPill();
          restoreSubmittedComposer(submittedDraft, submittedImages, undefined, isSlashCommand);
          console.error(`${isSlashCommand ? 'Prompt' : 'Steer'} rejected:`, response.error);
        } else {
          const data = response.data as Record<string, unknown> | undefined;
          if (data?.tree) {
            void branchTreeStore.open(sessionId, {
              tree: data.tree as import('@pimote/shared').PimoteTreeNode[],
              currentLeafId: (data.currentLeafId as string) ?? null,
            });
          } else if ((data as PromptResponseData | undefined)?.outcome !== 'queued') dropPill();
        }
      } catch (error) {
        dropPill();
        restoreSubmittedComposer(submittedDraft, submittedImages, undefined, isSlashCommand);
        console.error('Failed to send steer:', error);
      }
      return;
    }

    if (!text && stagedImages.length === 0) return;
    const submittedDraft = inputText;
    const submittedImages = [...stagedImages];
    const clientMessageId = text.startsWith('/') ? undefined : crypto.randomUUID();
    if (clientMessageId) sessionRegistry.addOptimisticUserMessage(sessionId, text, clientMessageId, submittedImages);
    clearSubmittedComposer();
    const dropOptimistic = () => {
      if (clientMessageId) sessionRegistry.dropOptimisticUserMessage(sessionId, clientMessageId);
    };
    try {
      const imageRefs = submittedImages.length > 0 ? await uploadImages(submittedImages) : [];
      const response = await send({
        type: 'prompt',
        message: text,
        ...(imageRefs.length > 0 ? { images: imageRefs } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      if (!response.success) {
        dropOptimistic();
        restoreSubmittedComposer(submittedDraft, submittedImages, clientMessageId);
        console.error('Prompt rejected:', response.error);
      } else {
        const data = response.data as Record<string, unknown> | undefined;
        if (data?.tree) {
          void branchTreeStore.open(sessionId, {
            tree: data.tree as import('@pimote/shared').PimoteTreeNode[],
            currentLeafId: (data.currentLeafId as string) ?? null,
          });
        } else if (clientMessageId && (data as PromptResponseData | undefined)?.outcome !== 'started') dropOptimistic();
      }
    } catch (error) {
      dropOptimistic();
      restoreSubmittedComposer(submittedDraft, submittedImages, clientMessageId);
      console.error('Failed to send prompt:', error);
    }
  }

  function handleAbort() {
    if (conversation) void abortSession(conversation.sessionId);
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
    setSurfaceDraft(inputText);
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
    setSurfaceDraft(inputText);
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
    if (e.key !== 'Escape' || e.defaultPrevented || isMobileViewport() || branchTreeStore.state.open || loginStore.state.flow !== 'idle' || !surfaceStreaming()) return;
    e.preventDefault();
    handleAbort();
  }

  async function dequeueSteeringMessage(text: string): Promise<void> {
    const sessionId = conversation?.sessionId;
    if (!sessionId) return;
    try {
      const response = await sessionRegistry.sendSurfaceCommand(sessionId, { type: 'dequeue_steering', message: text });
      if (!response.success) console.error('Failed to dequeue steering message:', response.error);
    } catch (error) {
      console.error('Failed to dequeue steering message:', error);
    }
  }

  function settleComposerText(text: string): void {
    // Caret to the end and height fit, once Svelte has written the value into
    // the textarea (scrollHeight reads stale otherwise).
    tick().then(() => {
      if (!textareaEl) return;
      textareaEl.selectionStart = textareaEl.selectionEnd = text.length;
      autoResize();
    });
  }

  function applyHistoryEntry(text: string): void {
    inputText = text;
    setSurfaceDraft(text);
    // A pending steering message pulled into the composer leaves the queue so
    // the agent never receives it; the pill shrinks via queue_update.
    const queued = conversation?.pendingSteeringMessages;
    if (queued && queued.lastIndexOf(text) !== -1) void dequeueSteeringMessage(text);
    settleComposerText(text);
  }

  function recallPrevious(): boolean {
    const entries = historyEntries;
    if (entries.length === 0) return false;
    if (historyStash === null) historyStash = inputText;
    const index = entries.lastIndexOf(inputText);
    const next = index === -1 ? entries.length - 1 : Math.max(0, index - 1);
    applyHistoryEntry(entries[next]);
    return true;
  }

  function recallNext(): boolean {
    if (historyStash === null) return false;
    const entries = historyEntries;
    const index = entries.lastIndexOf(inputText);
    if (index !== -1 && index < entries.length - 1) {
      applyHistoryEntry(entries[index + 1]);
      return true;
    }
    // Past the newest entry: restore the stashed draft and leave history mode.
    restoreHistoryStash();
    return true;
  }

  // Exits history mode with the stashed draft (or an empty composer when the
  // draft itself was empty). Shared by Down past the newest entry and by End
  // at the end of the current entry.
  function restoreHistoryStash(): void {
    inputText = historyStash ?? '';
    setSurfaceDraft(inputText);
    historyStash = null;
    settleComposerText(inputText);
  }

  function handleKeydown(e: KeyboardEvent) {
    // Intercept keys when autocomplete is visible
    if (autocompleteVisible && autocompleteRef) {
      if (e.key === 'ArrowUp' && autocompleteRef.moveUp()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown' && autocompleteRef.moveDown()) {
        e.preventDefault();
        return;
      }
      if (!e.shiftKey && (e.key === 'Tab' || e.key === 'Enter') && autocompleteRef.accept()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        autocompleteRef.dismiss();
        return;
      }
    }

    if (e.key === 'Escape' && surfaceStreaming()) {
      e.preventDefault();
      e.stopPropagation();
      handleAbort();
      return;
    }

    // History recall only in message mode. Up steps to older entries when the
    // caret sits on the first visual row (soft-wrapped rows count); Down steps
    // forward from the last visual row, so multiline caret movement stays untouched.
    if (!isBangCommand && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && textareaEl) {
      if (e.key === 'ArrowUp' && caretOnFirstVisualRow(textareaEl) && recallPrevious()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown' && caretOnLastVisualRow(textareaEl) && recallNext()) {
        e.preventDefault();
        return;
      }
    }

    // End at the end of the current entry drops straight to the list bottom —
    // the stashed draft (or empty) — and leaves history mode. Caret elsewhere
    // keeps the native jump to line end. Mod+End sticks the transcript to the
    // bottom globally.
    if (e.key === 'End' && historyStash !== null && textareaEl && textareaEl.selectionStart === inputText.length) {
      restoreHistoryStash();
      e.preventDefault();
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
    {#if surfaceStreaming()}
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
        sessionId={conversation?.sessionId ?? ''}
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
        id={isBangCommand ? undefined : 'session-composer'}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={updateAutocomplete}
        onpaste={handlePaste}
        disabled={noSession || isPending}
        tabindex={isBangCommand ? -1 : 0}
        aria-hidden={isBangCommand}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : isPending ? 'Starting session…' : surfaceStreaming() ? 'Steer the conversation…' : 'Send a message…'}
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
        id={isBangCommand ? 'session-composer' : undefined}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onclick={updateAutocomplete}
        onpaste={handlePaste}
        disabled={noSession || isPending}
        tabindex={isBangCommand ? 0 : -1}
        aria-hidden={!isBangCommand}
        rows={1}
        placeholder={noSession ? 'Open a session to start…' : isPending ? 'Starting session…' : surfaceStreaming() ? 'Steer the conversation…' : 'Send a message…'}
        autocapitalize="none"
        spellcheck={false}
        aria-label="Bash command"
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm transition-colors focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50
          {isBangCommand
          ? 'border-warning bg-warning/10 focus:border-warning focus:ring-warning font-mono [font-variant-ligatures:none]'
          : 'pointer-events-none absolute inset-0 opacity-0'}
          {dragOver ? 'ring-ring ring-2' : ''}"
      ></textarea>

      <!-- History recall position: entries above, draft or exit below -->
      {#if historyNavigation}
        <div
          class="text-muted-foreground pointer-events-none absolute bottom-1.5 left-0.5 flex flex-col items-center gap-0.5"
          aria-hidden="true"
          data-testid="composer-history-nav"
        >
          {#if historyNavigation.older}
            <ChevronUp class="size-3.5" />
          {/if}
          <ChevronDown class="size-3.5" />
        </div>
      {/if}

      <!-- Send / Steer button (inset in textarea) -->
      <button
        class="absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-lg p-1.5 text-sm font-medium transition-colors
          {!canSend || (surfaceStreaming() ? !inputText.trim() : !hasContent)
          ? 'text-muted-foreground cursor-not-allowed opacity-50'
          : surfaceStreaming()
            ? 'bg-status-streaming text-primary-foreground hover:bg-status-streaming/80 active:bg-status-streaming/70'
            : 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'}"
        onpointerdown={(e) => e.preventDefault()}
        onclick={sendMessage}
        disabled={!canSend || (surfaceStreaming() ? !inputText.trim() : !hasContent)}
        title={surfaceStreaming() ? 'Steer' : 'Send'}
      >
        {#if surfaceStreaming()}
          <MessageSquare class="size-5" />
        {:else}
          <Send class="size-5" />
        {/if}
      </button>
    </div>
  </div>
</div>
