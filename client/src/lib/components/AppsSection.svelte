<script lang="ts">
  import type { AppInfo } from '@pimote/shared';
  import { Button } from '$lib/components/ui/button/index.js';
  import { appsStore, type AppsStore } from '$lib/stores/apps-store.svelte.js';
  import AppDialog from './AppDialog.svelte';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  interface Props {
    store?: AppsStore;
  }

  let { store = appsStore }: Props = $props();

  let dialogOpen = $state(false);
  let dialogMode = $state<'create' | 'edit'>('create');
  let editingApp = $state<AppInfo | null>(null);
  let confirmingRemoveSlug = $state<string | null>(null);
  let busyRemoveSlug = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  function openCreate(): void {
    dialogMode = 'create';
    editingApp = null;
    dialogOpen = true;
  }

  function openEdit(app: AppInfo): void {
    dialogMode = 'edit';
    editingApp = app;
    dialogOpen = true;
  }

  function displayHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  async function confirmRemove(slug: string): Promise<void> {
    busyRemoveSlug = slug;
    actionError = null;
    try {
      const result = await store.remove(slug);
      if (!result.ok) {
        actionError = result.error;
      }
      confirmingRemoveSlug = null;
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      busyRemoveSlug = null;
    }
  }

  async function handleResync(): Promise<void> {
    actionError = null;
    const result = await store.resync();
    if (!result.ok) {
      actionError = result.error;
    }
  }
</script>

<AppDialog
  bind:open={dialogOpen}
  mode={dialogMode}
  app={editingApp}
  {store}
  onClose={() => {
    editingApp = null;
  }}
/>

<section class="flex flex-col gap-3" aria-label="Apps">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-muted-foreground text-xs font-semibold tracking-wider uppercase">Apps</h2>
      {#if store.apps.length > 0}
        <span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
          {store.apps.length}
        </span>
      {/if}
    </div>
    <Button variant="ghost" size="sm" class="h-8 gap-1.5 px-2.5 text-xs" onclick={openCreate}>
      <Plus class="size-3.5" />
      Add app
    </Button>
  </div>

  {#if store.sync.status === 'error'}
    <div class="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-sm" role="alert">
      <div class="flex min-w-0 items-center gap-2">
        <AlertTriangle class="size-4 shrink-0" />
        <span class="truncate">Route sync failed: {store.sync.error ?? 'Caddy unreachable'}</span>
      </div>
      <Button variant="outline" size="sm" class="h-7 gap-1.5 text-xs" disabled={store.resyncing} onclick={handleResync}>
        <RefreshCw class="size-3.5 {store.resyncing ? 'animate-spin' : ''}" />
        {store.resyncing ? 'Syncing...' : 'Resync'}
      </Button>
    </div>
  {/if}

  {#if actionError || store.error}
    <p class="text-destructive text-sm" role="alert">{actionError ?? store.error}</p>
  {/if}

  {#if store.apps.length > 0}
    <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {#each store.apps as app (app.slug)}
        <div class="border-border bg-card hover:border-primary/40 flex items-start justify-between gap-3 rounded-xl border p-3.5 transition-colors">
          <!-- eslint-disable svelte/no-navigation-without-resolve -->
          <a href={app.url} target="_blank" rel="noopener noreferrer" class="group flex min-w-0 flex-1 flex-col gap-1 focus-visible:outline-none">
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
            <div class="flex items-center gap-1.5">
              <span class="text-foreground group-hover:text-primary truncate font-medium transition-colors">{app.title}</span>
              <ExternalLink class="text-muted-foreground size-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
            </div>
            {#if app.description}
              <p class="text-muted-foreground line-clamp-2 text-sm">{app.description}</p>
            {/if}
            {#if app.icon}
              <span class="text-muted-foreground truncate text-xs">Icon: {app.icon}</span>
            {/if}
            <span class="text-muted-foreground truncate font-mono text-xs">{displayHost(app.url)}</span>
          </a>

          <div class="flex shrink-0 items-center gap-1">
            {#if confirmingRemoveSlug === app.slug}
              <Button variant="destructive" size="sm" class="h-7 px-2 text-xs" disabled={busyRemoveSlug === app.slug} onclick={() => confirmRemove(app.slug)}>
                {busyRemoveSlug === app.slug ? 'Removing...' : 'Remove'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                disabled={busyRemoveSlug === app.slug}
                onclick={() => {
                  confirmingRemoveSlug = null;
                }}
              >
                Cancel
              </Button>
            {:else}
              <Button variant="ghost" size="icon" class="size-8" aria-label="Edit {app.title}" title="Edit app" onclick={() => openEdit(app)}>
                <Pencil class="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-destructive size-8"
                aria-label="Remove {app.title}"
                title="Remove app"
                onclick={() => {
                  confirmingRemoveSlug = app.slug;
                }}
              >
                <Trash2 class="size-3.5" />
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else if store.loaded}
    <p class="text-muted-foreground text-sm">No apps registered yet.</p>
  {/if}
</section>
