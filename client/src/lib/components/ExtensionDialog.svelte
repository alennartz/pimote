<script lang="ts">
  import { untrack } from 'svelte';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
  import { getExtensionEditorHost } from '$lib/stores/extension-editor-host.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import { getExtensionDialogInitialValue } from '$lib/extension-dialog-state.js';
  import ExtensionEditorWorkspaces from '$lib/components/ExtensionEditorWorkspaces.svelte';

  const uiQueue = getExtensionUiQueue();
  const editorHost = getExtensionEditorHost();

  let dialogOpen = $state(false);
  let inputValue = $state('');

  let current = $derived(uiQueue.modalCurrent);
  let currentInput = $derived(current?.method === 'input' ? current : null);

  $effect(() => {
    editorHost.setViewedSession(sessionRegistry.viewedSessionId);
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

<!-- Editor workspaces render as global session surfaces on desktop. On mobile
     the session page mounts them inside its scroll flow instead. -->
{#if !isMobileViewport()}
  <ExtensionEditorWorkspaces />
{/if}
