<script lang="ts">
  import type { ThemeStore } from '../stores/theme-store.svelte.js';

  interface Props {
    store: ThemeStore;
    viewport?: 'desktop' | 'mobile';
    embedded?: boolean;
  }

  let { store, viewport = 'desktop', embedded = false }: Props = $props();
  let themes = $derived(store.catalog?.themes ?? []);
  let defaultThemeId = $derived(store.catalog?.defaultThemeId ?? null);
  let activeId = $derived(store.activeTheme?.id ?? null);
  let previewing = $derived(activeId !== store.selectedThemeId || store.previewThemeId !== store.selectedThemeId);

  function select(themeId: string | null): void {
    store.preview(themeId);
  }

  async function save(): Promise<void> {
    await store.save();
  }

  function cancel(): void {
    store.cancel();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Appearance" role="tabpanel">
  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
    <div>
      <h2 class="text-base font-semibold">Appearance</h2>
      <p class="text-muted-foreground mt-1 text-sm">Choose a paired interface and code palette. Preview changes stay on this device until saved.</p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2" role="listbox" aria-label="Themes">
      <button
        type="button"
        role="option"
        aria-label="Follow server default"
        aria-selected={activeId === (defaultThemeId ?? 'pimote/light') && store.selectedThemeId === null}
        class="border-border bg-card hover:bg-surface-hover flex min-h-28 flex-col rounded-xl border p-3 text-left transition-colors {activeId ===
          (defaultThemeId ?? 'pimote/light') && store.selectedThemeId === null
          ? 'ring-ring ring-2'
          : ''}"
        onclick={() => select(null)}
      >
        <span class="flex items-center justify-between gap-2 font-medium"
          >Follow server default <span class="text-muted-foreground text-xs">{themes.find((theme) => theme.id === defaultThemeId)?.name ?? 'Pimote Light'}</span></span
        >
        <span class="text-muted-foreground mt-2 text-xs">Uses the server choice on every device.</span>
        <span class="mt-auto flex gap-1 pt-3" aria-hidden="true">
          <span class="size-4 rounded-full border" style={`background: ${themes.find((theme) => theme.id === defaultThemeId)?.ui.background ?? 'var(--background)'}`}></span>
          <span class="size-4 rounded-full border" style={`background: ${themes.find((theme) => theme.id === defaultThemeId)?.editor.syntax.keyword ?? 'var(--foreground)'}`}
          ></span>
        </span>
      </button>

      {#each themes as theme (theme.id)}
        <button
          type="button"
          role="option"
          aria-label={theme.name}
          aria-selected={activeId === theme.id}
          class="border-border bg-card hover:bg-surface-hover flex min-h-28 flex-col rounded-xl border p-3 text-left transition-colors {activeId === theme.id
            ? 'ring-ring ring-2'
            : ''}"
          onclick={() => select(theme.id)}
        >
          <span class="flex items-start justify-between gap-2 font-medium">
            <span>{theme.name}</span>
            {#if theme.id === defaultThemeId}<span class="text-muted-foreground text-xs">Server default</span>{/if}
          </span>
          <span class="text-muted-foreground mt-1 text-xs capitalize">{theme.source} · {theme.colorScheme}</span>
          <span class="mt-auto flex gap-1 pt-3" aria-hidden="true">
            <span class="size-4 rounded-full border" style={`background: ${theme.ui.background}`}></span>
            <span class="size-4 rounded-full border" style={`background: ${theme.ui.primary}`}></span>
            <span class="size-4 rounded-full border" style={`background: ${theme.editor.syntax.keyword}`}></span>
            <span class="size-4 rounded-full border" style={`background: ${theme.editor.syntax.string}`}></span>
          </span>
        </button>
      {/each}
    </div>

    {#if previewing && activeId}
      <p class="text-muted-foreground text-sm" role="status">
        Previewing {themes.find((theme) => theme.id === activeId)?.name ?? activeId}. Save to sync this choice to other devices.
      </p>
    {:else}
      <p class="text-muted-foreground text-sm" role="status">Showing the saved theme.</p>
    {/if}
  </div>

  {#if !embedded}
    <div class="border-border flex shrink-0 items-center justify-end gap-2 border-t p-3 sm:p-4">
      {#if viewport === 'mobile'}
        <button type="button" class="border-border rounded-md border px-3 py-2 text-sm" aria-label="Close" onclick={cancel}>Close</button>
      {:else}
        <button type="button" class="border-border rounded-md border px-3 py-2 text-sm" onclick={cancel}>Cancel</button>
      {/if}
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
