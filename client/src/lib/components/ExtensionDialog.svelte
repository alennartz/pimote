<script lang="ts">
  import { getExtensionUiQueue, INLINE_METHODS } from '$lib/stores/extension-ui-queue.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import CodeEditorDialog from '$lib/components/CodeEditorDialog.svelte';
  import { getExtensionDialogInitialValue } from '$lib/extension-dialog-state.js';
  import type { ResolvedEditorLanguage } from '$lib/editor-language.js';

  const uiQueue = getExtensionUiQueue();

  let dialogOpen = $state(false);
  let inputValue = $state('');
  let confirmDiscardOpen = $state(false);

  // Filter to only show dialogs for the currently viewed session
  let current = $derived.by(() => {
    const viewedId = sessionRegistry.viewedSessionId;
    return uiQueue.all.find((r) => !INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
  });

  // Language detection is lazy too: editor-language pulls in highlight.js.
  let editorLanguage: ResolvedEditorLanguage | null = $state(null);

  $effect(() => {
    if (current?.method !== 'editor') {
      editorLanguage = null;
      return;
    }
    const title = current.title;
    const prefill = current.prefill as string | undefined;
    void import('$lib/editor-language.js').then((langMod) => {
      editorLanguage = langMod.resolveEditorLanguage(title, prefill);
    });
  });

  $effect(() => {
    if (current) {
      inputValue = getExtensionDialogInitialValue(current);
      dialogOpen = true;
      confirmDiscardOpen = false;
      return;
    }
    dialogOpen = false;
    confirmDiscardOpen = false;
  });

  let editorDirty = $derived(current?.method === 'editor' && inputValue !== getExtensionDialogInitialValue(current));

  function sendResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    if (!current) return;
    uiQueue.sendResponse(current.requestId, current.sessionId, data);
  }

  function handleCancel() {
    if (current?.method === 'editor' && editorDirty) {
      confirmDiscardOpen = true;
      return;
    }
    sendResponse({ cancelled: true });
  }

  function handleEditorInteractOutside() {
    if (!editorDirty) {
      sendResponse({ cancelled: true });
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open && current) {
      handleCancel();
    }
  }

  function discardAndCancel() {
    confirmDiscardOpen = false;
    sendResponse({ cancelled: true });
  }

  function handleInputSubmit() {
    sendResponse({ value: inputValue });
  }

  function handleEditorSubmit() {
    sendResponse({ value: inputValue });
  }
</script>

<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
  {#if current?.method === 'input'}
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>{current.title ?? 'Extension'}</Dialog.Title>
        {#if current.message}
          <Dialog.Description>{current.message}</Dialog.Description>
        {/if}
      </Dialog.Header>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleInputSubmit();
        }}
        class="flex flex-col gap-4"
      >
        <Input bind:value={inputValue} placeholder={(current.placeholder as string) ?? ''} autofocus />
        <Dialog.Footer>
          <Button variant="outline" type="button" onclick={handleCancel}>Cancel</Button>
          <Button type="submit">Submit</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  {/if}
</Dialog.Root>
{#if current?.method === 'editor'}
  <CodeEditorDialog
    bind:open={dialogOpen}
    title={current.title ?? 'Editor'}
    subtitle={(current.message as string | undefined) ?? null}
    badge={editorLanguage?.label ?? null}
    language={editorLanguage?.id ?? null}
    bind:value={inputValue}
    onclose={handleCancel}
    oninteractoutside={handleEditorInteractOutside}
    onsave={handleEditorSubmit}
  />
{/if}

<Dialog.Root bind:open={confirmDiscardOpen}>
  <Dialog.Content showCloseButton={false}>
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
