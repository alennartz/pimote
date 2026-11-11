import type { AgentPath, BorrowedAgentSession, FeedCursor, SubagentEvent, SubagentProvider, SubagentSnapshot, SubagentTeardownResult } from '@pimote/sdk/subagents';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import type { SessionSurface, SessionSurfaceCapabilities, SessionSurfaceCommand, SessionSurfaceOptions, SessionSurfaceSnapshot } from './session-surface.js';

/** Semantic events enter the parent surface's replay stream at its cursor. */
export type ParentSemanticEventSink = (event: SubagentEvent, parentCursor: number) => void;

export interface SubagentViewReference {
  readonly path: AgentPath;
  /** Opaque private generation for this connection-scoped attachment. */
  readonly attachmentGeneration: string;
}

export interface SubagentViewAttachment extends SubagentViewReference {
  readonly snapshot: SessionSurfaceSnapshot;
}

export type SubagentViewChange =
  | (SubagentViewReference & { type: 'snapshot'; snapshot: SessionSurfaceSnapshot })
  | (SubagentViewReference & { type: 'event'; event: PimoteSessionEvent })
  | (SubagentViewReference & { type: 'closed'; reason: 'replaced' | 'unavailable' | 'teardown' });

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
  emitViewChange: (connectionId: string, change: SubagentViewChange) => void;
  reconnectGraceMs: number;
  childCapabilities: (session: BorrowedAgentSession) => SessionSurfaceCapabilities;
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
  openView(connectionId: string, path: AgentPath): Promise<SubagentViewAttachment>;
  closeView(connectionId: string, view: SubagentViewReference): Promise<void>;
  dispatch(connectionId: string, view: SubagentViewReference, command: SessionSurfaceCommand): Promise<unknown>;
  /** Keep attachments during the grace period for this reconnect identity. */
  disconnect(connectionId: string): void;
  reconnect(connectionId: string): Promise<readonly SubagentViewAttachment[]>;
  teardown(path: AgentPath): Promise<SubagentTeardownResult>;
}

/** Construct the provider host for one root session. */
export function createSubagentHost(_options: SubagentHostOptions): SubagentHost {
  throw new Error('not implemented');
}
