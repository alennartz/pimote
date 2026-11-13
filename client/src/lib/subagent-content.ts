import type { PimoteAgentMessage, PimoteSessionEvent, SubagentContentDeltaEvent, SubagentContentEndEvent, SubagentContentStartEvent } from '../../../shared/src/protocol.js';

export type SubagentContentEvent = SubagentContentStartEvent | SubagentContentDeltaEvent | SubagentContentEndEvent;

export type ActiveSubagentContent = Readonly<import('../../../shared/src/protocol.js').PimoteActiveSubagentContent>;

export interface SubagentContentState {
  readonly messages: readonly PimoteAgentMessage[];
  readonly active: readonly ActiveSubagentContent[];
}

/** Apply one projected content lifecycle event without native reconciliation. */
export function applySubagentContentEvent(_state: SubagentContentState, _event: SubagentContentEvent): SubagentContentState {
  throw new Error('not implemented');
}

/** Load complete projected blocks and active operation snapshots together. */
export function hydrateSubagentContent(_messages: readonly PimoteAgentMessage[], _active: readonly ActiveSubagentContent[] = []): SubagentContentState {
  throw new Error('not implemented');
}

/** Narrow a session feed to dedicated projected-content lifecycle events. */
export function isSubagentContentEvent(event: PimoteSessionEvent): event is SubagentContentEvent {
  throw new Error('not implemented');
}
