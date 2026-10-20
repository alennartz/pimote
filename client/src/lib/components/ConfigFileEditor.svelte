<script lang="ts">
  import { tick } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import CodeEditorDialog from '$lib/components/CodeEditorDialog.svelte';
  import { fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import { isValidTagName, wrapWithTag } from '$lib/tag-wrap.js';
  import type { EditorView } from '@codemirror/view';
  import TagIcon from '@lucide/svelte/icons/tag';

  let editorView = $state<EditorView | null>(null);

  let tagInputVisible = $state(false);
  let tagName = $state('');
  let tagInputEl = $state<HTMLInputElement | null>(null);
  let confirmDiscardOpen = $state(false);

  // Toolbar state is per-open: no stale tag input or typed tag name.
  $effect(() => {
    if (!fileEditorStore.open) {
      tagInputVisible = false;
      tagName = '';
    }
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

  // Capture phase so the shortcut is consumed before CodeMirror's own
  // Mod-Shift-g binding (find previous) can also act on it.
  function onShortcutKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'g' || !event.ctrlKey || !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    tagInputVisible = true;
    void focusTagInput();
  }

  /** Close request (X, Cancel, Esc, overlay-click): unsaved edits must be confirmed first. */
  function requestClose(): void {
    if (fileEditorStore.saving) return;
    if (fileEditorStore.dirty) {
      confirmDiscardOpen = true;
      return;
    }
    fileEditorStore.close();
  }

  function discardAndClose(): void {
    confirmDiscardOpen = false;
    fileEditorStore.close();
  }
</script>

<CodeEditorDialog
  bind:open={fileEditorStore.open}
  title={fileEditorStore.title}
  subtitle={fileEditorStore.resolvedPath ?? fileEditorStore.path}
  hint={fileEditorStore.loaded && !fileEditorStore.exists ? 'New file — it will be created on save.' : null}
  error={fileEditorStore.error}
  saving={fileEditorStore.saving}
  saveDisabled={!fileEditorStore.loaded}
  ready={fileEditorStore.loaded}
  language="markdown"
  bind:value={fileEditorStore.content}
  bind:editorView
  onkeydowncapture={onShortcutKeydown}
  onclose={requestClose}
  onsave={() => void fileEditorStore.save()}
>
  {#snippet toolbar()}
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
  {/snippet}
</CodeEditorDialog>

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
