export type AgentPath = readonly string[];

export type SubagentNodeState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead';

export interface SubagentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface SubagentNodeMetadata {
  readonly persona?: string;
  readonly personaIcon?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly state: SubagentNodeState;
  readonly activity?: string;
  readonly usage?: SubagentUsage;
  readonly contextPercent?: number;
  readonly channels?: readonly string[];
  readonly waitingTargets?: readonly AgentPath[];
  readonly pendingCorrelations?: readonly string[];
  readonly lastOutput?: string;
  readonly lastError?: string;
}

export interface SubagentHierarchyNode extends SubagentNodeMetadata {
  readonly path: AgentPath;
  readonly label: string;
  readonly task: string;
  readonly hasChildren?: boolean;
}

export interface SubagentPanelSnapshot {
  readonly root: {
    readonly sessionId: string;
    readonly label: string;
  };
  readonly nodes: readonly SubagentHierarchyNode[];
}

export type SubagentSelectedView = { readonly kind: 'root' } | { readonly kind: 'child'; readonly path: AgentPath };

export interface SubagentViewNotice {
  readonly path: AgentPath;
  readonly reason: 'teardown' | 'unavailable';
}

export interface SubagentPanelState {
  readonly inspectedPath: AgentPath | null;
  readonly openChildPaths: readonly AgentPath[];
  readonly selectedView: SubagentSelectedView;
  readonly panelPresentation: 'sidebar' | 'drawer';
  readonly panelOpen: boolean;
  readonly notice: SubagentViewNotice | null;
  readonly teardownConfirmation: { readonly path: AgentPath } | null;
}

export interface SubagentPanelRow {
  readonly path: AgentPath;
  readonly depth: number;
  readonly label: string;
  readonly task: string;
  readonly metadata: SubagentNodeMetadata;
  readonly inspected: boolean;
  readonly viewOpen: boolean;
  readonly openAction: 'open' | 'show';
}

export type SubagentPanelAction =
  | { readonly type: 'inspect'; readonly path: AgentPath }
  | { readonly type: 'open_child_view'; readonly path: AgentPath }
  | { readonly type: 'close_child_view' }
  | { readonly type: 'view_closed'; readonly path: AgentPath; readonly reason: 'teardown' | 'unavailable' }
  | { readonly type: 'dismiss_notice' }
  | { readonly type: 'set_viewport_width'; readonly width: number }
  | { readonly type: 'toggle_panel' }
  | { readonly type: 'close_panel' };

export type SubagentTeardownAction =
  | { readonly type: 'request_teardown'; readonly target: 'selected_view' | 'inspected' }
  | { readonly type: 'cancel_teardown' }
  | { readonly type: 'confirm_teardown' };

export interface SubagentTeardownTransition {
  readonly state: SubagentPanelState;
  readonly request?: { readonly path: AgentPath };
}

/** Request confirmation or emit a teardown request without changing runtime ownership. */
export function reduceSubagentTeardown(_state: SubagentPanelState, _action: SubagentTeardownAction): SubagentTeardownTransition {
  throw new Error('not implemented');
}

/** Reduce explicit panel actions without changing child runtime ownership. */
export function reduceSubagentPanelState(_state: SubagentPanelState, _action: SubagentPanelAction): SubagentPanelState {
  throw new Error('not implemented');
}

/** Project hierarchy nodes into rows with inspection and open-view markers. */
export function projectSubagentPanelRows(_snapshot: SubagentPanelSnapshot, _state: SubagentPanelState): readonly SubagentPanelRow[] {
  throw new Error('not implemented');
}
