<script lang="ts">
  import { tick } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import type { GlobalSettingsStore } from '$lib/stores/global-settings.svelte.js';
  import { inferLanguageFromPath } from '$lib/editor-language.js';
  import { isValidTagName, wrapWithTag } from '$lib/tag-wrap.js';
  import { AlertDialog } from 'bits-ui';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import CodeEditorDialog from './CodeEditorDialog.svelte';
  import { globalSettingsPresentation } from './global-settings-presentation.js';
  import Settings from '@lucide/svelte/icons/settings';

  let {
    store,
    viewport = 'desktop',
    surface = 'home',
    snippets = [],
  }: {
    store: GlobalSettingsStore;
    viewport?: 'desktop' | 'mobile';
    surface?: 'home' | 'conversation';
    snippets?: readonly string[];
  } = $props();

  let active = $derived(store.files.find((file) => file.path === store.activePath));
  let presentation = $derived(globalSettingsPresentation({ surface, viewport, path: active?.path ?? '', dirty: active?.dirty ?? false, snippets }));
  let editorView = $state<EditorView | null>(null);
  let tagInputVisible = $state(false);
  let tagName = $state('');
  let tagInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!store.open || store.activePath) {
      tagInputVisible = false;
      tagName = '';
    }
  });

  async function showTagInput(): Promise<void> {
    tagInputVisible = !tagInputVisible;
    if (tagInputVisible) {
      await tick();
      tagInputEl?.focus();
    }
  }

  function applyWrap(tag: string): void {
    const view = editorView;
    if (!active?.loaded || !view || !isValidTagName(tag)) return;
    const { from, to } = view.state.selection.main;
    const result = wrapWithTag(view.state.doc.toString(), from, to, tag);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.text }, selection: { anchor: result.from, head: result.to } });
  }
</script>

{#if presentation.gear}
  <Button
    variant="ghost"
    size="icon"
    aria-label="Open Settings"
    title="Open Settings"
    class={viewport === 'mobile' ? 'settings-gear settings-gear-mobile' : 'settings-gear settings-gear-desktop'}
    onclick={() => void store.loadManifest()}><Settings class={viewport === 'mobile' ? 'size-5' : 'size-7'} /></Button
  >
{/if}

<CodeEditorDialog
  open={store.open}
  title={active?.label ?? ''}
  accessibleTitle="Global settings files"
  subtitle={active?.path ?? null}
  hint={active?.loaded && !active.exists ? 'New file. It will be created on save.' : active?.dirty ? 'Unsaved changes' : null}
  error={store.error ?? active?.error ?? null}
  saving={active?.saving ?? false}
  saveDisabled={!presentation.actions.saveEnabled || !active?.loaded}
  ready={active?.loaded ?? false}
  toolbarVisible={presentation.language === 'markdown'}
  language={inferLanguageFromPath(active?.path ?? '')}
  bind:value={
    () => active?.draft ?? '',
    (value) => {
      if (active) store.edit(active.path, value);
    }
  }
  bind:editorView
  {viewport}
  onclose={() => store.close()}
  onsave={() => {
    if (active) void store.save(active.path);
  }}
>
  {#snippet tabs()}
    <div aria-label="Settings files" class="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2" role="tablist">
      {#each store.files as file (file.path)}
        <Button
          type="button"
          variant={file.path === store.activePath ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={file.path === store.activePath}
          class="shrink-0"
          onclick={() => void store.select(file.path)}
        >
          {file.label}{#if file.dirty}<span aria-label="Unsaved changes">*</span>{/if}
        </Button>
      {/each}
    </div>
  {/snippet}
  {#snippet toolbar()}
    {#if presentation.language === 'markdown'}
      <Button variant="outline" size="sm" type="button" aria-expanded={tagInputVisible} onclick={() => void showTagInput()}>Tag</Button>
      {#if tagInputVisible}
        <Input
          bind:value={tagName}
          bind:ref={tagInputEl}
          aria-label="Tag name"
          placeholder="tag"
          class="h-8 w-28"
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyWrap(tagName);
            }
          }}
        />
        <Button size="sm" type="button" disabled={!isValidTagName(tagName) || !editorView} onclick={() => applyWrap(tagName)}>Wrap</Button>
      {/if}
      {#each presentation.tagSnippets as snippet (snippet)}
        <Button variant="outline" size="sm" type="button" aria-label="Wrap with {snippet}" onclick={() => applyWrap(snippet)}>{snippet}</Button>
      {/each}
    {/if}
  {/snippet}
</CodeEditorDialog>

<AlertDialog.Root
  open={store.discardConfirmation}
  onOpenChange={(open) => {
    if (!open) store.keepEditing();
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/50" />
    <AlertDialog.Content class="bg-background fixed top-1/2 left-1/2 z-[60] grid w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border p-5 shadow-lg">
      <AlertDialog.Title class="text-lg font-semibold">Discard unsaved changes?</AlertDialog.Title>
      <AlertDialog.Description class="text-muted-foreground text-sm">One or more settings files have unsaved edits.</AlertDialog.Description>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => store.keepEditing()}>Keep editing</Button>
        <Button variant="destructive" onclick={() => store.discardAndClose()}>Discard</Button>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<style>
  :global(.settings-gear) {
    position: fixed;
    z-index: 20;
    border-radius: 50%;
  }
  :global(.settings-gear-desktop) {
    width: 3.5rem;
    height: 3.5rem;
    left: max(1.5rem, env(safe-area-inset-left));
    bottom: max(1.5rem, env(safe-area-inset-bottom));
  }
  :global(.settings-mobile) {
    top: 0;
    left: 0;
    width: 100vw;
    max-width: none;
    height: 100dvh;
    transform: none;
    border-radius: 0;
  }
  :global(.settings-gear-mobile) {
    width: 2.5rem;
    height: 2.5rem;
    left: max(0.75rem, env(safe-area-inset-left));
    top: max(0.75rem, env(safe-area-inset-top));
  }
</style>
