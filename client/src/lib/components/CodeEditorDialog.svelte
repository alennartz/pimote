<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import type { Snippet } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import type { EditorLanguage } from '$lib/editor-language.js';
  import X from '@lucide/svelte/icons/x';

  /**
   * Shared chrome for the fullscreen code-editor dialogs (agents.md editing and
   * agent-initiated editor requests). Mobile puts Close and Save in the header
   * so no footer row consumes vertical space; desktop keeps a footer with
   * Cancel and Save. Lazy-loads the CodeMirror editor with a retry-on-reopen
   * failure state.
   */
  let {
    open = $bindable(false),
    title,
    subtitle = null,
    hint = null,
    badge = null,
    error = null,
    saving = false,
    saveDisabled = false,
    ready = true,
    language = null,
    value = $bindable(''),
    editorView = $bindable(null),
    toolbar = null,
    onclose,
    oninteractoutside = null,
    onsave,
    onkeydowncapture = null,
  }: {
    open?: boolean;
    title: string;
    /** Muted line under the title (path or agent message); full text on hover. */
    subtitle?: string | null;
    /** Second muted line, e.g. the will-create notice. */
    hint?: string | null;
    /** Header badge (detected language), desktop only. */
    badge?: string | null;
    /** Alert text: header row on mobile, footer-left on desktop. */
    error?: string | null;
    /** While true every control is disabled and Save reads "Saving…". */
    saving?: boolean;
    /** Extra save gate beside `saving`, e.g. content not loaded yet. */
    saveDisabled?: boolean;
    /** While false the code editor stays unmounted, e.g. file still loading. */
    ready?: boolean;
    language?: EditorLanguage | null;
    value?: string;
    /** Live CodeMirror view, for toolbars that act on the selection. */
    editorView?: EditorView | null;
    /** Row between header and body, e.g. the tag-wrap toolbar. */
    toolbar?: Snippet | null;
    /** Every explicit close affordance and unhandled Escape route here; the consumer owns veto and confirm semantics. */
    onclose: () => void;
    /** Outside interaction policy. Defaults to the explicit close policy. */
    oninteractoutside?: (() => void) | null;
    onsave: () => void;
    /** Capture-phase keydown listener on the dialog, ahead of CodeMirror's own bindings. */
    onkeydowncapture?: ((event: KeyboardEvent) => void) | null;
  } = $props();

  // Lazy-loaded editor (CodeMirror + highlight.js), only fetched when the
  // dialog opens.
  let editorModule: typeof import('$lib/components/ExtensionCodeEditor.svelte') | null = $state(null);
  let editorLoadError = $state<string | null>(null);
  let contentEl = $state<HTMLElement | null>(null);

  $effect(() => {
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

  $effect(() => {
    const el = contentEl;
    const handler = onkeydowncapture;
    if (!el || !handler) return;
    el.addEventListener('keydown', handler, { capture: true });
    return () => el.removeEventListener('keydown', handler, { capture: true });
  });

  /** Explicit Esc routes through `onclose` so the consumer can veto the close. */
  function onDismissAttempt(event: Event): void {
    event.preventDefault();
    onclose();
  }

  /** Outside interaction has a separate policy from explicit close affordances. */
  function onInteractOutside(event: Event): void {
    event.preventDefault();
    (oninteractoutside ?? onclose)();
  }

  function onOpenChange(next: boolean): void {
    if (!next) onclose();
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content
    showCloseButton={false}
    bind:ref={contentEl}
    onEscapeKeydown={onDismissAttempt}
    {onInteractOutside}
    class="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,960px)] sm:w-[min(96vw,1280px)] sm:max-w-[min(96vw,1280px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
  >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        onsave();
      }}
      class="flex h-full min-h-0 flex-col"
    >
      <header
        class="bg-background/95 z-10 flex shrink-0 flex-col gap-1 border-b px-3 py-2 backdrop-blur sm:px-5 sm:py-3"
        style="padding-top: max(0.5rem, env(safe-area-inset-top));"
      >
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="icon" type="button" class="size-11 sm:hidden" aria-label="Close editor" disabled={saving} onclick={onclose}>
            <X class="size-5" />
          </Button>
          <div class="min-w-0 flex-1 text-center sm:text-left">
            <div class="truncate text-base font-semibold sm:overflow-visible sm:break-words sm:whitespace-normal">{title}</div>
            {#if subtitle}
              <div class="text-muted-foreground truncate text-xs" title={subtitle}>{subtitle}</div>
            {/if}
            {#if hint}
              <div class="text-muted-foreground text-xs">{hint}</div>
            {/if}
          </div>
          {#if badge}
            <Badge variant="outline" class="hidden shrink-0 whitespace-nowrap sm:inline-flex">{badge}</Badge>
          {/if}
          <Button type="submit" class="h-11 sm:hidden" disabled={saving || saveDisabled}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {#if error}
          <p class="text-destructive text-sm break-words sm:hidden" role="alert">{error}</p>
        {/if}
      </header>

      {#if toolbar}
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-5">
          {@render toolbar()}
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0">
        {#if editorModule && ready}
          <editorModule.default bind:value bind:editorView {language} />
        {:else}
          <div class="flex h-full items-center justify-center">
            {#if editorLoadError}
              <span class="text-destructive text-sm">{editorLoadError}</span>
            {:else if error}
              <span class="text-destructive text-sm">The file could not be loaded.</span>
            {:else}
              <span class="text-muted-foreground text-sm">Loading editor…</span>
            {/if}
          </div>
        {/if}
      </div>

      <div
        class="bg-background/95 z-10 hidden shrink-0 gap-2 border-t px-5 py-3 backdrop-blur sm:flex sm:items-center sm:justify-end"
        style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom));"
      >
        {#if error}
          <p class="text-destructive mr-auto min-w-0 truncate text-sm" role="alert">{error}</p>
        {/if}
        <Button variant="outline" type="button" disabled={saving} onclick={onclose}>Cancel</Button>
        <Button type="submit" disabled={saving || saveDisabled}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
