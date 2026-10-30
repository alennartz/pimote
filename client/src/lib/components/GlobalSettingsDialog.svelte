<script lang="ts">
  import type { GlobalSettingsStore } from '$lib/stores/global-settings.svelte.js';

  interface Props {
    store: GlobalSettingsStore;
  }

  let { store }: Props = $props();
</script>

{#if store.open}
  <div role="dialog" aria-modal="true" aria-label="Global settings files" tabindex="-1">
    <nav aria-label="Settings files"></nav>
  </div>
{/if}
