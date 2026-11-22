<script lang="ts">
  import { appsStore, type AppsStore } from '$lib/stores/apps-store.svelte.js';
  import AppIcon from './AppIcon.svelte';

  interface Props {
    search?: string;
    store?: AppsStore;
  }

  let { search = '', store = appsStore }: Props = $props();

  let normalizedQuery = $derived(search.trim().toLowerCase());
  let filteredApps = $derived(normalizedQuery.length === 0 ? store.apps : store.apps.filter((app) => `${app.title} ${app.slug}`.toLowerCase().includes(normalizedQuery)));
</script>

{#if filteredApps.length > 0}
  <section class="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" aria-label="Apps">
    {#each filteredApps as app (app.slug)}
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a
        href={app.url}
        target="_blank"
        rel="noopener noreferrer"
        class="group flex min-w-0 flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:outline-none"
      >
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
        <AppIcon {app} />
        <span class="text-foreground group-hover:text-primary w-full truncate text-center text-xs font-medium transition-colors">{app.title}</span>
      </a>
    {/each}
  </section>
{/if}
