<script lang="ts">
  import type { BashExecutionState } from '$lib/stores/session-registry.svelte.js';

  export interface BashExecutionProps {
    execution: BashExecutionState;
    onCancel?: () => void;
  }

  let { execution: _execution, onCancel: _onCancel }: BashExecutionProps = $props();
</script>

<!-- Presentation contract stub; the implementation phase owns rendering rules. -->
<div data-testid="bash-execution"></div>
