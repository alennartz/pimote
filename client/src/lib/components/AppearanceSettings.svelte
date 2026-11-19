<script lang="ts">
  import type { ResolvedTheme } from '@pimote/shared';
  import type { ThemeStore } from '../stores/theme-store.svelte.js';

  interface Props {
    store: ThemeStore;
    viewport?: 'desktop' | 'mobile';
    embedded?: boolean;
  }

  let { store, viewport = 'desktop', embedded = false }: Props = $props();
  let themes = $derived(store.catalog?.themes ?? []);
  let defaultThemeId = $derived(store.catalog?.defaultThemeId ?? null);
  let defaultTheme = $derived(themes.find((theme) => theme.id === defaultThemeId) ?? themes.find((theme) => theme.id === 'pimote/light') ?? themes[0] ?? null);
  let activeTheme = $derived(store.activeTheme);
  let activeId = $derived(activeTheme?.id ?? null);
  let selectedId = $derived(store.effectiveSelectionId);
  let saveError = $state<string | null>(null);

  function isSelected(themeId: string): boolean {
    return selectedId === themeId;
  }

  function isDefaultSelected(): boolean {
    return selectedId === null;
  }

  function select(themeId: string | null): void {
    saveError = null;
    store.preview(themeId);
  }

  async function save(): Promise<void> {
    saveError = null;
    try {
      await store.save();
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    }
  }

  function cancel(): void {
    saveError = null;
    store.cancel();
  }
</script>

{#snippet miniPreview(theme: ResolvedTheme)}
  <span
    class="theme-preview"
    style={`--preview-bg: ${theme.editor.surface.background}; --preview-fg: ${theme.editor.surface.foreground}; --preview-muted: ${theme.editor.surface['gutter-foreground']}; --preview-line: ${theme.ui.border}; --preview-surface: ${theme.ui.card}; --preview-raised: ${theme.ui.muted}; --preview-accent: ${theme.ui.primary}; --preview-keyword: ${theme.editor.syntax.keyword}; --preview-function: ${theme.editor.syntax.function}; --preview-string: ${theme.editor.syntax.string}; --preview-number: ${theme.editor.syntax.number}; --preview-comment: ${theme.editor.syntax.comment}`}
    aria-hidden="true"
  >
    <span class="theme-preview-toolbar"><i></i><i></i><i></i><span>Pimote</span></span>
    <span class="theme-preview-content">
      <span class="theme-preview-panel">
        <span class="theme-preview-row active"><b></b>Folders</span>
        <span class="theme-preview-row">Sessions</span>
      </span>
      <span class="theme-preview-editor"><span class="keyword">const</span> x = <span class="number">42</span>;<br /><span class="comment">// Ready</span></span>
    </span>
  </span>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Appearance" role="tabpanel">
  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
    <div>
      <h2 class="text-base font-semibold">Color theme</h2>
      <p class="text-muted-foreground mt-1 text-sm">Select a full theme. Each choice includes the Pimote interface and code editor palettes.</p>
    </div>

    {#if store.isPreviewing}
      <p class="border-primary/30 bg-primary/5 text-foreground flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" role="status">
        <strong>Previewing {activeTheme?.name ?? activeId ?? 'theme'}</strong>
        <span class="text-muted-foreground"
          >Unsaved choice. Other devices still use {store.selectedThemeId === null
            ? 'the server default'
            : (themes.find((theme) => theme.id === store.selectedThemeId)?.name ?? store.selectedThemeId)}.</span
        >
      </p>
    {:else}
      <p class="text-muted-foreground text-sm" role="status">Showing the saved theme.</p>
    {/if}

    {#if saveError}
      <p class="text-destructive text-sm" role="alert">{saveError}</p>
    {/if}

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="listbox" aria-label="Themes">
      <button
        type="button"
        role="option"
        aria-label="Follow server default"
        aria-selected={isDefaultSelected()}
        class="theme-card border-border bg-card hover:bg-surface-hover flex min-w-0 flex-col rounded-xl border p-3 text-left transition-colors {isDefaultSelected()
          ? 'ring-ring ring-2'
          : ''}"
        onclick={() => select(null)}
      >
        {#if defaultTheme}{@render miniPreview(defaultTheme)}{/if}
        <span class="mt-2 flex items-start justify-between gap-2 font-medium">
          <span>Follow server default</span>
          <span class="text-muted-foreground text-xs">{defaultTheme?.name ?? 'Pimote Light'}</span>
        </span>
        <span class="text-muted-foreground mt-1 text-xs">Uses the server choice on every device.</span>
      </button>

      {#each themes as theme (theme.id)}
        <button
          type="button"
          role="option"
          aria-label={theme.name}
          aria-selected={isSelected(theme.id)}
          class="theme-card border-border bg-card hover:bg-surface-hover flex min-w-0 flex-col rounded-xl border p-3 text-left transition-colors {isSelected(theme.id)
            ? 'ring-ring ring-2'
            : ''}"
          onclick={() => select(theme.id)}
        >
          {@render miniPreview(theme)}
          <span class="mt-2 flex items-start justify-between gap-2 font-medium">
            <span class="min-w-0 truncate">{theme.name}</span>
            {#if theme.id === defaultThemeId}<span class="text-muted-foreground shrink-0 text-xs">Server default</span>{/if}
          </span>
          <span class="text-muted-foreground mt-1 text-xs capitalize">{theme.colorScheme} · {theme.source}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if !embedded}
    <div class="border-border flex shrink-0 items-center justify-end gap-2 border-t p-3 sm:p-4">
      <button type="button" class="border-border rounded-md border px-3 py-2 text-sm" aria-label={viewport === 'mobile' ? 'Close' : 'Cancel'} onclick={cancel}
        >{viewport === 'mobile' ? 'Close' : 'Cancel'}</button
      >
      <button
        type="button"
        class="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm"
        aria-label="Save theme"
        disabled={store.saveDisabled}
        onclick={() => void save()}>Save theme</button
      >
    </div>
  {/if}
</div>

<style>
  .theme-preview {
    display: block;
    width: 100%;
    height: 7rem;
    overflow: hidden;
    border: 1px solid var(--preview-line);
    border-radius: 0.5rem;
    color: var(--preview-fg);
    background: var(--preview-bg);
    font-size: 0.65rem;
  }

  .theme-preview-toolbar {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    height: 1.5rem;
    padding: 0 0.5rem;
    color: var(--preview-muted);
    background: var(--preview-raised);
    border-bottom: 1px solid var(--preview-line);
  }

  .theme-preview-toolbar i {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 50%;
    background: var(--preview-muted);
  }

  .theme-preview-toolbar span {
    margin-left: 0.25rem;
  }

  .theme-preview-content {
    display: grid;
    grid-template-columns: 1fr 1.1fr;
    height: calc(100% - 1.5rem);
  }

  .theme-preview-panel {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.4rem;
    color: var(--preview-muted);
    background: var(--preview-surface);
    border-right: 1px solid var(--preview-line);
  }

  .theme-preview-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1rem;
    padding: 0.1rem 0.2rem;
    border-radius: 0.2rem;
  }

  .theme-preview-row.active {
    color: var(--preview-fg);
    background: color-mix(in srgb, var(--preview-accent) 16%, transparent);
  }

  .theme-preview-row b {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 0.1rem;
    background: var(--preview-accent);
  }

  .theme-preview-editor {
    padding: 0.45rem;
    color: var(--preview-fg);
    background: var(--preview-bg);
    font:
      0.65rem/1.7 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    white-space: nowrap;
  }

  .theme-preview-editor .keyword {
    color: var(--preview-keyword);
  }

  .theme-preview-editor .number {
    color: var(--preview-number);
  }

  .theme-preview-editor .comment {
    color: var(--preview-comment);
  }
</style>
