<script lang="ts">
  import type { ThemeStore } from '../stores/theme-store.svelte.js';

  interface Props {
    store: ThemeStore;
    viewport?: 'desktop' | 'mobile';
  }

  let { store: _store, viewport: _viewport = 'desktop' }: Props = $props();
  throw new Error('not implemented');
</script>

<div aria-label="Appearance" role="tabpanel"></div>
