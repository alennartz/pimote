import type { AgentPath, FeedCursor, SubagentEvent, SubagentProvider, SubagentSnapshot, SubagentTeardownResult, SubagentLease } from '@pimote/sdk/subagents';
import type { SessionSurface, SessionSurfaceOptions, SessionSurfaceSnapshot } from './session-surface.js';

/** Semantic events enter the parent surface's replay stream at its cursor. */
export type ParentSemanticEventSink = (event: SubagentEvent, parentCursor: number) => void;

export interface SubagentViewAttachment {
  readonly path: AgentPath;
  /** Opaque private generation for this connection-scoped attachment. */
  readonly attachmentGeneration: string;
  readonly lease: SubagentLease;
  readonly surface: SessionSurface;
  readonly snapshot: SessionSurfaceSnapshot;
}

export interface SubagentHostStartResult {
  readonly snapshot: SubagentSnapshot;
  readonly providerCursor: FeedCursor;
  /** Parent cursor after the hierarchy snapshot boundary. */
  readonly parentCursor: number;
}

export interface SubagentHostOptions {
  rootSessionId: string;
  provider: SubagentProvider;
  parentSurface: SessionSurface;
  parentCursor: () => number;
  emitParentEvent: ParentSemanticEventSink;
  createChildSurface?: (options: SessionSurfaceOptions) => SessionSurface;
}

/**
 * Per-root provider host. It is not part of the root session-slot registry.
 *
 * The host owns connection-scoped child leases and view surfaces. Provider
 * events are projected into the parent surface; child transcript events stay on
 * each view surface's cursor.
 */
export interface SubagentHost {
  /** Subscribe to provider events before requesting the first hierarchy snapshot. */
  start(): Promise<SubagentHostStartResult>;
  openView(path: AgentPath): Promise<SubagentViewAttachment>;
  closeView(attachment: Pick<SubagentViewAttachment, 'path' | 'attachmentGeneration' | 'lease'>): Promise<void>;
  teardown(path: AgentPath): Promise<SubagentTeardownResult>;
}

/** Construct the provider host for one root session. */
export function createSubagentHost(_options: SubagentHostOptions): SubagentHost {
  throw new Error('not implemented');
}
