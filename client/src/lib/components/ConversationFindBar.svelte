<script lang="ts">
  import type { FindMatch } from '$lib/conversation-find.js';
  interface Props {
    matches: readonly FindMatch[];
    onMatch: (match: FindMatch) => void;
    onClose: () => void;
  }
  let { matches: _matches, onMatch: _onMatch, onClose: _onClose }: Props = $props();
</script>
