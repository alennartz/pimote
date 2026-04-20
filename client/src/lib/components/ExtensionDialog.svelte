<script lang="ts">
  import { getExtensionUiQueue, INLINE_METHODS } from '$lib/stores/extension-ui-queue.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { getExtensionDialogInitialValue } from '$lib/extension-dialog-state.js';
  import type { ResolvedEditorLanguage } from '$lib/editor-language.js';

  const uiQueue = getExtensionUiQueue();

  let dialogOpen = $state(false);
  let inputValue = $state('');

  // Filter to only show dialogs for the currently viewed session
  let current = $derived.by(() => {
    const viewedId = sessionRegistry.viewedSessionId;
    return uiQueue.all.find((r) => !INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
  });

  // Lazy-loaded editor deps (CodeMirror + highlight.js) — only fetched when editor dialog opens
  let editorModule: typeof import('$lib/components/ExtensionCodeEditor.svelte') | null = $state(null);
  let editorLanguage: ResolvedEditorLanguage | null = $state(null);

  $effect(() => {
    if (current?.method === 'editor') {
      // Kick off both lazy loads in parallel
      const title = current.title;
      const prefill = current.prefill as string | undefined;
      Promise.all([import('$lib/components/ExtensionCodeEditor.svelte'), import('$lib/editor-language.js')]).then(([mod, langMod]) => {
        editorModule = mod;
        editorLanguage = langMod.resolveEditorLanguage(title, prefill);
      });
    } else {
      editorModule = null;
      editorLanguage = null;
    }
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
      class="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,960px)] sm:w-[min(96vw,1280px)] sm:max-w-[min(96vw,1280px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
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
          {#if editorModule}
            <editorModule.default bind:value={inputValue} language={editorLanguage?.id ?? null} />
          {:else}
            <div class="flex h-full items-center justify-center">
              <span class="text-muted-foreground text-sm">Loading editor…</span>
            </div>
          {/if}
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
