<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
  import { getExtensionEditorHost } from '$lib/stores/extension-editor-host.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import CodeEditorDialog from '$lib/components/CodeEditorDialog.svelte';
  import { getExtensionDialogInitialValue } from '$lib/extension-dialog-state.js';
  import { workspaceKeyId, type EditorWorkspaceKey, type EditorWorkspaceRecord } from '$lib/extension-editor-workspace.js';
  import type { ResolvedEditorLanguage } from '$lib/editor-language.js';

  const uiQueue = getExtensionUiQueue();
  const editorHost = getExtensionEditorHost();

  let dialogOpen = $state(false);
  let inputValue = $state('');
  let confirmDiscardOpen = $state(false);
  let discardKey = $state<EditorWorkspaceKey | null>(null);
  let editorWorkspaces = $state<readonly EditorWorkspaceRecord[]>([...editorHost.workspaces]);
  const editorLanguages = new SvelteMap<string, ResolvedEditorLanguage | null>();
  const languageLoads = new SvelteSet<string>();

  let current = $derived(uiQueue.modalCurrent);
  let currentInput = $derived(current?.method === 'input' ? current : null);
  let activeEditor = $derived.by(() => {
    // The host is an imperative module. Read the reactive snapshot first so
    // Svelte re-evaluates this projection when a request changes.
    editorWorkspaces.length;
    return editorHost.active;
  });

  onMount(() => {
    const syncWorkspaces = () => {
      editorWorkspaces = [...editorHost.workspaces];
    };
    syncWorkspaces();
    return editorHost.subscribe(syncWorkspaces);
  });

  $effect(() => {
    editorHost.setViewedSession(sessionRegistry.viewedSessionId);
  });

  // Language detection remains lazy, but each pending request now owns its
  // result. A late import cannot replace another session's language badge.
  $effect(() => {
    const liveKeys = new Set(editorWorkspaces.map((workspace) => workspaceKeyId(workspace.key)));
    for (const key of editorLanguages.keys()) {
      if (!liveKeys.has(key)) editorLanguages.delete(key);
    }
    for (const workspace of editorWorkspaces) {
      const key = workspaceKeyId(workspace.key);
      if (editorLanguages.has(key) || languageLoads.has(key)) continue;
      languageLoads.add(key);
      editorLanguages.set(key, null);
      void import('$lib/editor-language-resolve.js')
        .then((langMod) => {
          if (liveKeys.has(key)) editorLanguages.set(key, langMod.resolveEditorLanguage(workspace.request.title, workspace.request.prefill));
        })
        .finally(() => languageLoads.delete(key));
    }
  });

  $effect(() => {
    const request = currentInput;
    if (!request) {
      dialogOpen = false;
      return;
    }
    // Draft reads stay untracked so typing does not trigger this initializer.
    inputValue = untrack(() => getExtensionDialogInitialValue(request));
    dialogOpen = true;
    confirmDiscardOpen = false;
    discardKey = null;
  });

  $effect(() => {
    const key = discardKey;
    if (!key) return;
    const stillPending = editorWorkspaces.some((workspace) => workspace.key.sessionId === key.sessionId && workspace.key.requestId === key.requestId);
    const active = activeEditor;
    const stillActive = active?.key.sessionId === key.sessionId && active.key.requestId === key.requestId;
    if (!stillPending || !stillActive) {
      discardKey = null;
      confirmDiscardOpen = false;
    }
  });

  function sendInputResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const request = currentInput;
    if (!request) return;
    void uiQueue.sendResponse(request.requestId, request.sessionId, data);
  }

  function handleCancelInput() {
    sendInputResponse({ cancelled: true });
  }

  function handleOpenChange(open: boolean) {
    if (!open && currentInput) handleCancelInput();
  }

  function handleInputSubmit() {
    sendInputResponse({ value: inputValue });
  }

  function handleEditorClose(workspace: EditorWorkspaceRecord): void {
    if (workspace.status !== 'pending') return;
    if (workspace.dirty) {
      discardKey = workspace.key;
      confirmDiscardOpen = true;
      return;
    }
    void editorHost.answer(workspace.key, 'cancel');
  }

  function handleEditorInteractOutside(workspace: EditorWorkspaceRecord): void {
    if (workspace.status === 'pending' && !workspace.dirty) void editorHost.answer(workspace.key, 'cancel');
  }

  function handleEditorSave(workspace: EditorWorkspaceRecord): void {
    if (workspace.status === 'pending') void editorHost.answer(workspace.key, 'save');
  }

  function discardAndCancel(): void {
    const key = discardKey;
    discardKey = null;
    confirmDiscardOpen = false;
    if (key) void editorHost.answer(key, 'discard');
  }
</script>

<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
  {#if currentInput}
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>{currentInput.title ?? 'Extension'}</Dialog.Title>
        {#if currentInput.message}
          <Dialog.Description>{currentInput.message}</Dialog.Description>
        {/if}
      </Dialog.Header>

      <form
        onsubmit={(event) => {
          event.preventDefault();
          handleInputSubmit();
        }}
        class="flex flex-col gap-4"
      >
        <Input bind:value={inputValue} placeholder={(currentInput.placeholder as string) ?? ''} autofocus />
        <Dialog.Footer>
          <Button variant="outline" type="button" onclick={handleCancelInput}>Cancel</Button>
          <Button type="submit">Submit</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  {/if}
</Dialog.Root>

{#each editorWorkspaces as workspace (workspaceKeyId(workspace.key))}
  {@const language = editorLanguages.get(workspaceKeyId(workspace.key))}
  <CodeEditorDialog
    open={activeEditor?.key.sessionId === workspace.key.sessionId && activeEditor?.key.requestId === workspace.key.requestId}
    preserveMount
    sessionSurface
    title={workspace.request.title ?? 'Editor'}
    subtitle={workspace.request.message ?? null}
    badge={language?.label ?? null}
    language={language?.id ?? null}
    editorKey={workspaceKeyId(workspace.key)}
    bind:value={() => editorHost.getValue(workspace.key) ?? '', (value: string) => editorHost.setValue(workspace.key, value)}
    onclose={() => handleEditorClose(workspace)}
    oninteractoutside={() => handleEditorInteractOutside(workspace)}
    onsave={() => handleEditorSave(workspace)}
  />
{/each}

<Dialog.Root bind:open={confirmDiscardOpen} onOpenChange={(open) => !open && (discardKey = null)}>
  <Dialog.Content showCloseButton={false} overlayClass="z-[60]" class="z-[60]">
    <Dialog.Header>
      <Dialog.Title>Discard unsaved changes?</Dialog.Title>
      <Dialog.Description>Your edits have not been saved.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (confirmDiscardOpen = false)}>Keep editing</Button>
      <Button variant="destructive" onclick={discardAndCancel}>Discard</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
