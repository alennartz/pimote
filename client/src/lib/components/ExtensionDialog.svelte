<script lang="ts">
  import { getExtensionUiQueue, INLINE_METHODS } from '$lib/stores/extension-ui-queue.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { getExtensionDialogInitialValue } from '$lib/extension-dialog-state.js';
  import { resolveEditorLanguage } from '$lib/editor-language.js';
  import ExtensionCodeEditor from '$lib/components/ExtensionCodeEditor.svelte';

  const uiQueue = getExtensionUiQueue();

  let dialogOpen = $state(false);
  let inputValue = $state('');

  // Filter to only show dialogs for the currently viewed session
  let current = $derived.by(() => {
    const viewedId = sessionRegistry.viewedSessionId;
    return uiQueue.all.find((r) => !INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
  });

  let editorLanguage = $derived.by(() => {
    if (!current || current.method !== 'editor') return null;
    return resolveEditorLanguage(current.title, current.prefill as string | undefined);
  });

  $effect(() => {
    if (current) {
      inputValue = getExtensionDialogInitialValue(current);
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
  {:else if current?.method === 'editor'}
    <Dialog.Content
      showCloseButton={false}
      class="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,960px)] sm:w-[min(96vw,1280px)] sm:max-w-[min(96vw,1280px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
    >
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleEditorSubmit();
        }}
        class="flex h-full min-h-0 flex-col"
      >
        <header
          class="bg-background/95 sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b px-4 py-3 backdrop-blur sm:px-5"
          style="padding-top: max(0.75rem, env(safe-area-inset-top));"
        >
          <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="w-full min-w-0 sm:w-auto">
              <div class="text-base font-semibold break-words">{current.title ?? 'Editor'}</div>
              {#if current.message}
                <div class="text-muted-foreground mt-1 text-sm">{current.message}</div>
              {/if}
            </div>
            {#if editorLanguage}
              <Badge variant="outline" class="max-w-full shrink-0 whitespace-nowrap">{editorLanguage.label}</Badge>
            {/if}
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-hidden">
          <ExtensionCodeEditor bind:value={inputValue} language={editorLanguage?.id ?? null} />
        </div>

        <div
          class="bg-background/95 sticky bottom-0 z-10 flex shrink-0 flex-col gap-2 border-t px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-end sm:px-5"
          style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom));"
        >
          <Button variant="outline" type="button" class="w-full sm:w-auto" onclick={handleCancel}>Cancel</Button>
          <Button type="submit" class="w-full sm:w-auto">Save</Button>
        </div>
      </form>
    </Dialog.Content>
  {/if}
</Dialog.Root>
