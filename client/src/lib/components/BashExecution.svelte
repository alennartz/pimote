<script lang="ts">
  import type { PimoteAgentMessage } from '@pimote/shared';
  import type { BashExecutionState } from '$lib/stores/session-registry.svelte.js';

  /** Persisted native bash result accepted by the shared presentation boundary. */
  export type FinalBashExecutionMessage = PimoteAgentMessage & {
    role: 'bashExecution';
    command: string;
    output: string;
    cancelled: boolean;
    truncated: boolean;
  };

  export interface BashExecutionProps {
    execution: BashExecutionState | FinalBashExecutionMessage;
    onCancel?: () => void;
  }

  let { execution: _execution, onCancel: _onCancel }: BashExecutionProps = $props();
</script>

<!-- Presentation contract stub; the implementation phase owns rendering rules. -->
<div data-testid="bash-execution"></div>
