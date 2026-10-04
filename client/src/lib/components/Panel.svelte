<script lang="ts">
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import CardList from './CardList.svelte';
</script>

<div class="bg-sidebar flex h-full w-70 flex-col overflow-y-auto border-l p-2">
  <CardList cards={panelStore.cards} />
</div>
