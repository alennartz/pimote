<script lang="ts">
  import { getExtensionUiQueue, INLINE_METHODS } from '$lib/stores/extension-ui-queue.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  const uiQueue = getExtensionUiQueue();

  let dialogOpen = $state(false);
  let inputValue = $state('');

  // Filter to only show dialogs for the currently viewed session
  let current = $derived.by(() => {
    const viewedId = sessionRegistry.viewedSessionId;
    return uiQueue.all.find((r) => !INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
  });

  $effect(() => {
    if (current) {
      if (current.method === 'input') {
        inputValue = (current.placeholder as string) ?? '';
      } else if (current.method === 'editor') {
        inputValue = (current.content as string) ?? '';
      }
      dialogOpen = true;
    } else {
      dialogOpen = false;
    }
  });

  function sendResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    if (!current) return;
    uiQueue.sendResponse(current.requestId, current.sessionId, data);
  }

  function handleCancel() {
    sendResponse({ cancelled: true });
  }

  function handleOpenChange(open: boolean) {
    if (!open && current) {
      handleCancel();
    }
  }

  function handleInputSubmit() {
    sendResponse({ value: inputValue });
  }

  function handleEditorSubmit() {
    sendResponse({ value: inputValue });
  }
</script>

<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
  {#if current}
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>{current.title ?? 'Extension'}</Dialog.Title>
        {#if current.message}
          <Dialog.Description>{current.message}</Dialog.Description>
        {/if}
      </Dialog.Header>

      {#if current.method === 'input'}
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
      {:else if current.method === 'editor'}
        <form
          onsubmit={(e) => {
            e.preventDefault();
            handleEditorSubmit();
          }}
          class="flex flex-col gap-4"
        >
          <textarea
            bind:value={inputValue}
            class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-[200px] w-full rounded-lg border bg-transparent px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-3"
          ></textarea>
          <Dialog.Footer>
            <Button variant="outline" type="button" onclick={handleCancel}>Cancel</Button>
            <Button type="submit">Save</Button>
          </Dialog.Footer>
        </form>
      {/if}
    </Dialog.Content>
  {/if}
</Dialog.Root>
