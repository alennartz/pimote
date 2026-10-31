<script lang="ts">
  import type { BranchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  interface Props {
    entryId: string;
    abandonedBranchCount: number;
    manager?: boolean;
    readOnly?: boolean;
    store: Pick<BranchTreeStore, 'navigate' | 'openFocused'>;
    sessionId: string;
  }
  let {
    entryId: _entryId,
    abandonedBranchCount: _abandonedBranchCount,
    manager: _manager = false,
    readOnly: _readOnly = false,
    store: _store,
    sessionId: _sessionId,
  }: Props = $props();
</script>
