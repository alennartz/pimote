<script lang="ts">
  import { tick } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import { isValidTagName, wrapWithTag } from '$lib/tag-wrap.js';
  import type { EditorView } from '@codemirror/view';
  import TagIcon from '@lucide/svelte/icons/tag';

  // Lazy-loaded editor deps (CodeMirror + highlight.js) — only fetched when the
  // dialog opens, same bundle posture as ExtensionDialog.
  let editorModule: typeof import('$lib/components/ExtensionCodeEditor.svelte') | null = $state(null);
  let editorLoadError = $state<string | null>(null);
  let editorView = $state<EditorView | null>(null);
  let dialogEl = $state<HTMLElement | null>(null);

  let tagInputVisible = $state(false);
  let tagName = $state('');
  let tagInputEl = $state<HTMLInputElement | null>(null);
  let confirmDiscardOpen = $state(false);

  $effect(() => {
    const open = fileEditorStore.open;
    if (!open) {
      // A fresh open retries a previously failed chunk load.
      if (editorLoadError) editorLoadError = null;
      return;
    }
    if (editorModule || editorLoadError) return;
    void import('$lib/components/ExtensionCodeEditor.svelte')
      .then((mod) => {
        editorModule = mod;
      })
      .catch(() => {
        // A stale PWA chunk or offline load must not leave the dialog stuck on
        // the loading placeholder with no error state.
        editorLoadError = 'The editor failed to load. Close and reopen to retry.';
      });
  });

  // Capture phase so the shortcut is consumed before CodeMirror's own
  // Mod-Shift-g binding (find previous) can also act on it.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    el.addEventListener('keydown', onShortcutKeydown, { capture: true });
    return () => el.removeEventListener('keydown', onShortcutKeydown, { capture: true });
  });

  let canWrap = $derived(isValidTagName(tagName));

  function toggleTagInput(): void {
    tagInputVisible = !tagInputVisible;
    if (tagInputVisible) void focusTagInput();
  }

  async function focusTagInput(): Promise<void> {
    await tick();
    tagInputEl?.focus();
  }

  /** Wraps the editor's current selection with `tag` (block-insert at a cursor). */
  function applyWrap(tag: string): void {
    const view = editorView;
    if (!view || !isValidTagName(tag)) return;
    const { from, to } = view.state.selection.main;
    const result = wrapWithTag(view.state.doc.toString(), from, to, tag);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.text },
      selection: { anchor: result.from, head: result.to },
    });
  }

  function onTagInputKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyWrap(tagName);
  }

  function onShortcutKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'g' || !event.ctrlKey || !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    tagInputVisible = true;
    void focusTagInput();
  }

  /** Close request (Cancel button): unsaved changes must be confirmed first. */
  function requestClose(): void {
    if (fileEditorStore.dirty) {
      confirmDiscardOpen = true;
      // Decline the close: keep the store and dialog open together.
      fileEditorStore.open = true;
      return;
    }
    fileEditorStore.close();
  }

  /** Esc and overlay-click: veto the close while unsaved edits exist. */
  function onDismissAttempt(event: Event): void {
    if (!fileEditorStore.dirty) return;
    event.preventDefault();
    confirmDiscardOpen = true;
    fileEditorStore.open = true;
  }

  function discardAndClose(): void {
    confirmDiscardOpen = false;
    fileEditorStore.close();
  }

  function onOpenChange(open: boolean): void {
    if (!open) requestClose();
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void fileEditorStore.save();
  }
</script>

<Dialog.Root bind:open={fileEditorStore.open} {onOpenChange}>
  <Dialog.Content
    showCloseButton={false}
    bind:ref={dialogEl}
    onEscapeKeydown={onDismissAttempt}
    onInteractOutside={onDismissAttempt}
    class="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,960px)] sm:w-[min(96vw,1280px)] sm:max-w-[min(96vw,1280px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
  >
    <form onsubmit={onSubmit} class="flex h-full min-h-0 flex-col">
      <header class="bg-background/95 z-10 flex shrink-0 flex-col gap-1 border-b px-4 py-3 backdrop-blur sm:px-5" style="padding-top: max(0.75rem, env(safe-area-inset-top));">
        <div class="text-base font-semibold break-words">{fileEditorStore.title}</div>
        <div class="text-muted-foreground truncate text-xs">{fileEditorStore.resolvedPath ?? fileEditorStore.path}</div>
        {#if fileEditorStore.loaded && !fileEditorStore.exists}
          <div class="text-muted-foreground text-xs">New file — it will be created on save.</div>
        {/if}
      </header>

      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-5">
        <Button variant="outline" size="sm" type="button" aria-label="Wrap selection with a tag" aria-expanded={tagInputVisible} onclick={toggleTagInput}>
          <TagIcon class="size-4" />
          Tag
        </Button>
        {#if tagInputVisible}
          <Input bind:value={tagName} bind:ref={tagInputEl} aria-label="Tag name" placeholder="tag" class="h-8 w-28" onkeydown={onTagInputKeydown} />
          <Button size="sm" type="button" disabled={!canWrap || !editorView} onclick={() => applyWrap(tagName)}>Wrap</Button>
        {/if}
        {#each fileEditorStore.snippets as snippet (snippet)}
          <Button variant="outline" size="sm" type="button" aria-label="Wrap with {snippet}" onclick={() => applyWrap(snippet)}>
            {snippet}
          </Button>
        {/each}
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        {#if editorModule && fileEditorStore.loaded}
          <editorModule.default bind:value={fileEditorStore.content} bind:editorView language="markdown" />
        {:else}
          <div class="flex h-full items-center justify-center">
            {#if editorLoadError}
              <span class="text-destructive text-sm">{editorLoadError}</span>
            {:else if fileEditorStore.error}
              <span class="text-destructive text-sm">The file could not be loaded.</span>
            {:else}
              <span class="text-muted-foreground text-sm">Loading editor…</span>
            {/if}
          </div>
        {/if}
      </div>

      <div
        class="bg-background/95 z-10 flex shrink-0 flex-col gap-2 border-t px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-end sm:px-5"
        style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom));"
      >
        {#if fileEditorStore.error}
          <p class="text-destructive w-full min-w-0 truncate text-sm sm:mr-auto">{fileEditorStore.error}</p>
        {/if}
        <Button variant="outline" type="button" class="w-full sm:w-auto" onclick={requestClose}>Cancel</Button>
        <Button type="submit" class="w-full sm:w-auto" disabled={fileEditorStore.saving || !fileEditorStore.loaded}>
          {fileEditorStore.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={confirmDiscardOpen}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Discard unsaved changes?</Dialog.Title>
      <Dialog.Description>Your edits have not been saved.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (confirmDiscardOpen = false)}>Keep editing</Button>
      <Button variant="destructive" onclick={discardAndClose}>Discard</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
