import type { PimoteAgentMessage, PimoteSessionEvent } from '../../shared/dist/index.js';
import type { ActiveSubagentOperation, SubagentPresentationManifest, SubagentProviderEvent } from '@pimote/sdk/subagents';
import type { IncomingSdkEvent } from './event-buffer.js';

export interface SubagentProjectionSnapshot {
  readonly messages: readonly PimoteAgentMessage[];
  readonly activeOperations: readonly ActiveSubagentOperation[];
}

export interface SubagentTranscriptProjectorOptions {
  readonly sessionId: string;
  readonly manifest: SubagentPresentationManifest;
}

/** Server-side transcript projection seam for native and semantic events. */
export interface SubagentTranscriptProjector {
  acceptNativeEvent(event: IncomingSdkEvent): readonly PimoteSessionEvent[];
  acceptProviderEvent(event: SubagentProviderEvent): readonly PimoteSessionEvent[];
  snapshot(): SubagentProjectionSnapshot;
  rehydrate(messages: readonly PimoteAgentMessage[]): void;
}

/** Interface-only factory. Projection logic belongs to the implementation phase. */
export function createSubagentTranscriptProjector(_options: SubagentTranscriptProjectorOptions): SubagentTranscriptProjector {
  throw new Error('not implemented');
}
