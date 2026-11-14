import type { SubagentNodeSnapshot as WireSubagentNodeSnapshot, SubagentSnapshot as WireSubagentSnapshot } from '../../../shared/src/protocol.js';

export type AgentPath = readonly string[];

export type SubagentNodeState = 'running' | 'waiting' | 'idle' | 'errored' | 'dead';

export interface SubagentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Provider usage field names before panel projection. */
export interface SubagentWireUsage {
  readonly input: number;
  readonly output: number;
  readonly cost: number;
}

export interface SubagentNodeMetadata {
  readonly persona?: string;
  readonly personaIcon?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly state: SubagentNodeState;
  readonly activity?: string;
  readonly usage?: SubagentUsage | SubagentWireUsage;
  readonly contextPercent?: number;
  readonly channels?: readonly string[];
  readonly waitingTargets?: readonly AgentPath[];
  readonly lastOutput?: string;
  readonly lastError?: string;
}

export interface SubagentHierarchyNode extends SubagentNodeMetadata {
  readonly path: AgentPath;
  readonly label?: string;
  readonly task?: string;
  readonly hasChildren?: boolean;
  /** Wire aliases accepted at the projection seam. */
  readonly contextFill?: number;
  readonly waitingFor?: readonly AgentPath[];
  readonly hasSubgroup?: boolean;
  /** The provider identity is useful when a teardown confirmation is open. */
  readonly incarnation?: string;
}

export interface SubagentPanelSnapshot {
  readonly root: {
    readonly sessionId: string;
    readonly label: string;
  };
  readonly nodes: readonly SubagentHierarchyNode[];
}

/** The wire snapshot has no root row and uses provider field names. */
type WirePanelSnapshot = Pick<WireSubagentSnapshot, 'nodes'>;
type PanelSnapshotInput = SubagentPanelSnapshot | WirePanelSnapshot;

export type SubagentSelectedView =
  | { readonly kind: 'root' }
  | {
      readonly kind: 'child';
      readonly path: AgentPath;
      readonly incarnation?: string;
      readonly attachmentGeneration?: string;
    };

export interface SubagentViewNotice {
  readonly path: AgentPath;
  readonly reason: 'teardown' | 'unavailable';
}

export interface SubagentTeardownConfirmation {
  readonly path: AgentPath;
  readonly incarnation?: string;
  readonly attachmentGeneration?: string;
}

export interface SubagentPanelState {
  readonly inspectedPath: AgentPath | null;
  readonly openChildPaths: readonly AgentPath[];
  readonly selectedView: SubagentSelectedView;
  readonly panelPresentation: 'sidebar' | 'drawer';
  readonly panelOpen: boolean;
  readonly notice: SubagentViewNotice | null;
  readonly teardownConfirmation: SubagentTeardownConfirmation | null;
}

export interface SubagentPanelRow {
  readonly path: AgentPath;
  readonly depth: number;
  readonly label: string;
  readonly task: string;
  readonly metadata: SubagentNodeMetadata;
  /** A live row can still act; errored and dead rows are terminal. */
  readonly live: boolean;
  readonly inspected: boolean;
  readonly viewOpen: boolean;
  readonly openAction: 'open' | 'show';
}

export type SubagentPanelAction =
  | { readonly type: 'inspect'; readonly path: AgentPath }
  | {
      readonly type: 'open_child_view';
      readonly path: AgentPath;
      readonly incarnation?: string;
      readonly attachmentGeneration?: string;
    }
  | { readonly type: 'close_child_view' }
  | { readonly type: 'view_closed'; readonly path: AgentPath; readonly reason: 'teardown' | 'unavailable' }
  | { readonly type: 'dismiss_notice' }
  | { readonly type: 'set_viewport_width'; readonly width: number }
  | { readonly type: 'toggle_panel' }
  | { readonly type: 'close_panel' };

export type SubagentTeardownAction =
  | {
      readonly type: 'request_teardown';
      readonly target: 'selected_view' | 'inspected';
      readonly incarnation?: string;
      readonly attachmentGeneration?: string;
    }
  | { readonly type: 'cancel_teardown' }
  | { readonly type: 'confirm_teardown' };

export interface SubagentTeardownTransition {
  readonly state: SubagentPanelState;
  readonly request?: {
    readonly path: AgentPath;
    readonly incarnation?: string;
    readonly attachmentGeneration?: string;
  };
}

const PANEL_DRAWER_BREAKPOINT = 620;

function copyPath(path: AgentPath): AgentPath {
  return Object.freeze([...path]);
}

function samePath(left: AgentPath | null | undefined, right: AgentPath | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left.length === right.length && left.every((part, index) => part === right[index]);
}

function isPathPrefix(prefix: AgentPath, path: AgentPath): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function withoutPath(paths: readonly AgentPath[], target: AgentPath, removeDescendants = false): readonly AgentPath[] {
  return Object.freeze(paths.filter((path) => !samePath(path, target) && (!removeDescendants || !isPathPrefix(target, path))).map(copyPath));
}

function withPath(paths: readonly AgentPath[], target: AgentPath): readonly AgentPath[] {
  if (paths.some((path) => samePath(path, target))) return Object.freeze(paths.map(copyPath));
  return Object.freeze([...paths.map(copyPath), copyPath(target)]);
}

function isNarrow(width: number): boolean {
  return Number.isFinite(width) && width <= PANEL_DRAWER_BREAKPOINT;
}

function panelForWidth(state: SubagentPanelState, width: number): Pick<SubagentPanelState, 'panelPresentation' | 'panelOpen'> {
  if (isNarrow(width)) {
    return { panelPresentation: 'drawer', panelOpen: false };
  }
  return { panelPresentation: 'sidebar', panelOpen: true };
}

function selectedPath(state: SubagentPanelState): AgentPath | null {
  return state.selectedView.kind === 'child' ? state.selectedView.path : null;
}

/** Request confirmation or emit a teardown request without changing runtime ownership. */
export function reduceSubagentTeardown(state: SubagentPanelState, action: SubagentTeardownAction): SubagentTeardownTransition {
  if (action.type === 'cancel_teardown') {
    return { state: { ...state, teardownConfirmation: null } };
  }

  if (action.type === 'confirm_teardown') {
    const confirmation = state.teardownConfirmation;
    if (!confirmation) return { state };
    return {
      state: { ...state, teardownConfirmation: null },
      request: {
        path: copyPath(confirmation.path),
        ...(confirmation.incarnation !== undefined ? { incarnation: confirmation.incarnation } : {}),
        ...(confirmation.attachmentGeneration !== undefined ? { attachmentGeneration: confirmation.attachmentGeneration } : {}),
      },
    };
  }

  const path = action.target === 'selected_view' ? selectedPath(state) : state.inspectedPath;
  if (!path || path.length === 0) return { state };

  const selected = state.selectedView.kind === 'child' && samePath(state.selectedView.path, path) ? state.selectedView : undefined;
  const confirmation: SubagentTeardownConfirmation = {
    path: copyPath(path),
    ...(action.incarnation !== undefined ? { incarnation: action.incarnation } : selected?.incarnation !== undefined ? { incarnation: selected.incarnation } : {}),
    ...(action.attachmentGeneration !== undefined
      ? { attachmentGeneration: action.attachmentGeneration }
      : selected?.attachmentGeneration !== undefined
        ? { attachmentGeneration: selected.attachmentGeneration }
        : {}),
  };
  return { state: { ...state, teardownConfirmation: confirmation } };
}

/** Reduce explicit panel actions without changing child runtime ownership. */
export function reduceSubagentPanelState(state: SubagentPanelState, action: SubagentPanelAction): SubagentPanelState {
  switch (action.type) {
    case 'inspect':
      return { ...state, inspectedPath: copyPath(action.path) };

    case 'open_child_view': {
      if (action.path.length === 0) return state;
      const openChildPaths = withPath(state.openChildPaths, action.path);
      const selectedView: SubagentSelectedView = {
        kind: 'child',
        path: copyPath(action.path),
        ...(action.incarnation !== undefined ? { incarnation: action.incarnation } : {}),
        ...(action.attachmentGeneration !== undefined ? { attachmentGeneration: action.attachmentGeneration } : {}),
      };
      return {
        ...state,
        openChildPaths,
        selectedView,
        panelOpen: state.panelPresentation === 'drawer' ? false : state.panelOpen,
      };
    }

    case 'close_child_view': {
      const selected = selectedPath(state);
      if (!selected) return state;
      return {
        ...state,
        openChildPaths: withoutPath(state.openChildPaths, selected),
        selectedView: { kind: 'root' },
      };
    }

    case 'view_closed': {
      const selected = selectedPath(state);
      const removeDescendants = action.reason === 'teardown';
      const openChildPaths = withoutPath(state.openChildPaths, action.path, removeDescendants);
      const closesSelection = selected !== null && (samePath(action.path, selected) || (removeDescendants && isPathPrefix(action.path, selected)));
      return {
        ...state,
        openChildPaths,
        selectedView: closesSelection ? { kind: 'root' } : state.selectedView,
        notice: { path: copyPath(action.path), reason: action.reason },
        teardownConfirmation:
          state.teardownConfirmation &&
          (samePath(action.path, state.teardownConfirmation.path) || (removeDescendants && isPathPrefix(action.path, state.teardownConfirmation.path)))
            ? null
            : state.teardownConfirmation,
      };
    }

    case 'dismiss_notice':
      return { ...state, notice: null };

    case 'set_viewport_width':
      return { ...state, ...panelForWidth(state, action.width) };

    case 'toggle_panel':
      return { ...state, panelOpen: !state.panelOpen };

    case 'close_panel':
      return { ...state, panelOpen: false };

    default:
      return state;
  }
}

interface WireNodeProjection {
  readonly path: AgentPath;
  readonly label?: string;
  readonly task?: string;
  readonly persona?: string;
  readonly personaIcon?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly state: SubagentNodeState;
  readonly activity?: string;
  readonly usage?: SubagentUsage | SubagentWireUsage;
  readonly contextPercent?: number;
  readonly contextFill?: number;
  readonly channels?: readonly string[];
  readonly waitingTargets?: readonly AgentPath[];
  readonly waitingFor?: readonly AgentPath[];
  readonly hasChildren?: boolean;
  readonly hasSubgroup?: boolean;
  readonly lastOutput?: string;
  readonly lastError?: string;
  readonly incarnation?: string;
}

function projectUsage(usage: WireNodeProjection['usage']): SubagentUsage | undefined {
  if (!usage) return undefined;
  if ('inputTokens' in usage) {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    };
  }
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    costUsd: usage.cost,
  };
}

type ProjectedHierarchyNode = Omit<SubagentHierarchyNode, 'label' | 'usage'> & {
  readonly label: string;
  readonly usage?: SubagentUsage;
};

function projectNode(node: SubagentHierarchyNode | WireSubagentNodeSnapshot): ProjectedHierarchyNode {
  const candidate = node as unknown as WireNodeProjection;
  const path = copyPath(candidate.path);
  const task = candidate.task;
  const waitingTargets = candidate.waitingTargets ?? candidate.waitingFor;
  const contextPercent = candidate.contextPercent ?? candidate.contextFill;
  const hasChildren = candidate.hasChildren ?? candidate.hasSubgroup;
  const usage = projectUsage(candidate.usage);
  return {
    path,
    label: candidate.label ?? path[path.length - 1] ?? '',
    ...(task !== undefined ? { task } : {}),
    ...(candidate.persona !== undefined ? { persona: candidate.persona } : {}),
    ...(candidate.personaIcon !== undefined ? { personaIcon: candidate.personaIcon } : {}),
    ...(candidate.model !== undefined ? { model: candidate.model } : {}),
    ...(candidate.thinkingLevel !== undefined ? { thinkingLevel: candidate.thinkingLevel } : {}),
    state: candidate.state,
    ...(candidate.activity !== undefined ? { activity: candidate.activity } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
    ...(candidate.channels !== undefined ? { channels: Object.freeze([...candidate.channels]) } : {}),
    ...(waitingTargets !== undefined ? { waitingTargets: Object.freeze(waitingTargets.map(copyPath)) } : {}),
    ...(hasChildren !== undefined ? { hasChildren } : {}),
    ...(candidate.lastOutput !== undefined ? { lastOutput: candidate.lastOutput } : {}),
    ...(candidate.lastError !== undefined ? { lastError: candidate.lastError } : {}),
    ...(candidate.incarnation !== undefined ? { incarnation: candidate.incarnation } : {}),
  };
}

/** Project hierarchy nodes into rows with inspection and open-view markers. */
export function projectSubagentPanelRows(snapshot: PanelSnapshotInput, state: SubagentPanelState): readonly SubagentPanelRow[] {
  return Object.freeze(
    snapshot.nodes.map((rawNode) => {
      const node = projectNode(rawNode);
      const path = copyPath(node.path);
      const viewOpen = state.openChildPaths.some((openPath) => samePath(openPath, path));
      const openAction: SubagentPanelRow['openAction'] = viewOpen ? 'show' : 'open';
      const live = node.state !== 'errored' && node.state !== 'dead';
      return {
        path,
        depth: Math.max(0, path.length - 1),
        label: node.label,
        task: node.task ?? '',
        metadata: {
          ...(node.persona !== undefined ? { persona: node.persona } : {}),
          ...(node.personaIcon !== undefined ? { personaIcon: node.personaIcon } : {}),
          ...(node.model !== undefined ? { model: node.model } : {}),
          ...(node.thinkingLevel !== undefined ? { thinkingLevel: node.thinkingLevel } : {}),
          state: node.state,
          ...(node.activity !== undefined ? { activity: node.activity } : {}),
          ...(node.usage !== undefined ? { usage: { costUsd: node.usage.costUsd } as SubagentUsage } : {}),
          ...(node.contextPercent !== undefined ? { contextPercent: node.contextPercent } : {}),
          ...(node.channels !== undefined ? { channels: node.channels } : {}),
          ...(node.waitingTargets !== undefined ? { waitingTargets: node.waitingTargets } : {}),
          ...(node.lastOutput !== undefined ? { lastOutput: node.lastOutput } : {}),
          ...(node.lastError !== undefined ? { lastError: node.lastError } : {}),
        },
        live,
        inspected: samePath(state.inspectedPath, path),
        viewOpen,
        openAction,
      };
    }),
  );
}
