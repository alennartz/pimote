import { describe, expect, it } from 'vitest';
import {
  projectSubagentPanelRows,
  reduceSubagentPanelState,
  reduceSubagentTeardown,
  type AgentPath,
  type SubagentPanelSnapshot,
  type SubagentPanelState,
} from './subagent-view-state.js';

const workerPath: AgentPath = ['worker'];
const scoutPath: AgentPath = ['worker', 'scout'];
const explorerPath: AgentPath = ['explorer'];

const snapshot: SubagentPanelSnapshot = {
  root: { sessionId: 'root-session', label: 'Main session' },
  nodes: [
    {
      path: workerPath,
      label: 'worker',
      task: 'Review auth callback ownership.',
      persona: 'reviewer',
      personaIcon: '◆',
      model: 'provider/model',
      thinkingLevel: 'cheap',
      state: 'running',
      activity: 'checking redirect ownership',
      usage: { inputTokens: 4200, outputTokens: 1100, costUsd: 0.04 },
      contextPercent: 31,
      channels: ['parent', 'scout'],
      waitingTargets: [scoutPath],
      lastOutput: 'Checking the redirect path.',
      hasChildren: true,
    },
    {
      path: scoutPath,
      label: 'scout',
      task: 'Confirm callback session mutation.',
      persona: 'scout',
      personaIcon: '⌕',
      model: 'provider/model',
      thinkingLevel: 'medium',
      state: 'waiting',
      activity: 'waiting for worker',
      usage: { inputTokens: 1800, outputTokens: 420, costUsd: 0.02 },
      contextPercent: 24,
      channels: ['worker', 'parent'],
      waitingTargets: [workerPath],
      lastOutput: 'Awaiting worker response.',
    },
    {
      path: explorerPath,
      label: 'explorer',
      task: 'Map repository structure.',
      persona: 'explorer',
      model: 'provider/model',
      thinkingLevel: 'cheap',
      state: 'idle',
      usage: { inputTokens: 1100, outputTokens: 380, costUsd: 0.01 },
      contextPercent: 12,
    },
  ],
};

const rootState: SubagentPanelState = {
  inspectedPath: null,
  openChildPaths: [],
  selectedView: { kind: 'root' },
  panelPresentation: 'sidebar',
  panelOpen: true,
  notice: null,
  teardownConfirmation: null,
};

describe('subagent panel and child-view state', () => {
  it('inspects a hierarchy row without opening or selecting a child view', () => {
    const state = reduceSubagentPanelState(rootState, { type: 'inspect', path: workerPath });

    expect(state.inspectedPath).toEqual(workerPath);
    expect(state.openChildPaths).toEqual([]);
    expect(state.selectedView).toEqual({ kind: 'root' });
  });

  it('opens a child only through the explicit open action', () => {
    const state = reduceSubagentPanelState(rootState, { type: 'open_child_view', path: workerPath });

    expect(state.openChildPaths).toEqual([workerPath]);
    expect(state.selectedView).toEqual({ kind: 'child', path: workerPath });
  });

  it('keeps multiple views open while switching and inspecting another child', () => {
    const worker = reduceSubagentPanelState(rootState, { type: 'open_child_view', path: workerPath });
    const scout = reduceSubagentPanelState(worker, { type: 'open_child_view', path: scoutPath });
    const inspected = reduceSubagentPanelState(scout, { type: 'inspect', path: explorerPath });
    const switched = reduceSubagentPanelState(inspected, { type: 'open_child_view', path: workerPath });

    expect(inspected.selectedView).toEqual({ kind: 'child', path: scoutPath });
    expect(inspected.openChildPaths).toHaveLength(2);
    expect(switched.selectedView).toEqual({ kind: 'child', path: workerPath });
    expect(switched.openChildPaths).toHaveLength(2);
    expect(switched.openChildPaths).toEqual(expect.arrayContaining([workerPath, scoutPath]));
    const rows = projectSubagentPanelRows(snapshot, switched);
    expect(rows.find((row) => row.path.join('/') === 'worker')?.viewOpen).toBe(true);
    expect(rows.find((row) => row.path.join('/') === 'worker/scout')?.viewOpen).toBe(true);
  });

  it('closes the selected child view and returns the conversation to the root', () => {
    const childState: SubagentPanelState = {
      ...rootState,
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: workerPath },
    };

    const state = reduceSubagentPanelState(childState, { type: 'close_child_view' });

    expect(state.selectedView).toEqual({ kind: 'root' });
    expect(state.openChildPaths).toEqual([scoutPath]);
    expect(state.notice).toBeNull();
  });

  it('returns to root and reports removal when the selected view is torn down', () => {
    const worker = reduceSubagentPanelState(rootState, { type: 'open_child_view', path: workerPath });
    const scout = reduceSubagentPanelState(worker, { type: 'open_child_view', path: scoutPath });
    const removed = reduceSubagentPanelState(scout, { type: 'view_closed', path: scoutPath, reason: 'teardown' });

    expect(removed.selectedView).toEqual({ kind: 'root' });
    expect(removed.openChildPaths).toContainEqual(workerPath);
    expect(removed.openChildPaths).not.toContainEqual(scoutPath);
    expect(removed.notice).toMatchObject({ path: scoutPath, reason: 'teardown' });
    expect(reduceSubagentPanelState(removed, { type: 'dismiss_notice' }).notice).toBeNull();
  });

  it('keeps the current conversation when a different open view becomes unavailable', () => {
    const worker = reduceSubagentPanelState(rootState, { type: 'open_child_view', path: workerPath });
    const scout = reduceSubagentPanelState(worker, { type: 'open_child_view', path: scoutPath });
    const closed = reduceSubagentPanelState(scout, { type: 'view_closed', path: workerPath, reason: 'unavailable' });

    expect(closed.selectedView).toEqual({ kind: 'child', path: scoutPath });
    expect(closed.openChildPaths).toContainEqual(scoutPath);
    expect(closed.openChildPaths).not.toContainEqual(workerPath);
    expect(closed.notice).toMatchObject({ path: workerPath, reason: 'unavailable' });
  });

  it('requests confirmation for the selected child, not the differently inspected child', () => {
    const state: SubagentPanelState = {
      ...rootState,
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: scoutPath },
    };
    const confirmation = reduceSubagentTeardown(state, { type: 'request_teardown', target: 'selected_view' });

    expect(confirmation.state.teardownConfirmation).toMatchObject({ path: scoutPath });
    expect(confirmation.request).toBeUndefined();
  });

  it('cancels teardown without requesting removal or closing the child view', () => {
    const state: SubagentPanelState = {
      ...rootState,
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: scoutPath },
      teardownConfirmation: { path: scoutPath },
    };
    const canceled = reduceSubagentTeardown(state, { type: 'cancel_teardown' });

    expect(canceled.request).toBeUndefined();
    expect(canceled.state.teardownConfirmation).toBeNull();
    expect(canceled.state.selectedView).toEqual({ kind: 'child', path: scoutPath });
    expect(canceled.state.openChildPaths).toEqual(expect.arrayContaining([workerPath, scoutPath]));
    expect(canceled.state.notice).toBeNull();
    expect(reduceSubagentTeardown(canceled.state, { type: 'confirm_teardown' }).request).toBeUndefined();
  });

  it('confirms teardown for the selected child, not the differently inspected child', () => {
    const state: SubagentPanelState = {
      ...rootState,
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: scoutPath },
      teardownConfirmation: { path: scoutPath },
    };
    const confirmed = reduceSubagentTeardown(state, { type: 'confirm_teardown' });

    expect(confirmed.request).toMatchObject({ path: scoutPath });
    expect(confirmed.state.teardownConfirmation).toBeNull();
    expect(confirmed.state.openChildPaths).toEqual(expect.arrayContaining([workerPath, scoutPath]));
    expect(confirmed.state.selectedView).toEqual({ kind: 'child', path: scoutPath });
  });

  it('requests confirmation for the inspected child when teardown starts from its inspector', () => {
    const state: SubagentPanelState = {
      ...rootState,
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: scoutPath },
    };
    const confirmation = reduceSubagentTeardown(state, { type: 'request_teardown', target: 'inspected' });

    expect(confirmation.state.teardownConfirmation).toMatchObject({ path: workerPath });
    expect(confirmation.request).toBeUndefined();
  });

  it('uses a dismissible drawer on a narrow screen without changing view selection on inspection', () => {
    const narrow = reduceSubagentPanelState(rootState, { type: 'set_viewport_width', width: 390 });
    expect(narrow.panelPresentation).toBe('drawer');
    expect(narrow.panelOpen).toBe(false);
    const opened = reduceSubagentPanelState(narrow, { type: 'toggle_panel' });
    const inspected = reduceSubagentPanelState(opened, { type: 'inspect', path: workerPath });
    expect(inspected.panelOpen).toBe(true);
    expect(inspected.selectedView).toEqual({ kind: 'root' });
    const viewing = reduceSubagentPanelState(inspected, { type: 'open_child_view', path: workerPath });
    expect(viewing.panelOpen).toBe(false);
    expect(viewing.selectedView).toEqual({ kind: 'child', path: workerPath });
    const reopened = reduceSubagentPanelState(viewing, { type: 'toggle_panel' });
    expect(reduceSubagentPanelState(reopened, { type: 'close_panel' }).panelOpen).toBe(false);
  });

  it('keeps the sidebar open when opening a child on a wide screen', () => {
    const wide = reduceSubagentPanelState(rootState, { type: 'set_viewport_width', width: 1120 });
    const viewing = reduceSubagentPanelState(wide, { type: 'open_child_view', path: workerPath });
    expect(viewing.panelPresentation).toBe('sidebar');
    expect(viewing.panelOpen).toBe(true);
  });

  it('projects metadata and open markers without adding the root to the hierarchy', () => {
    const rows = projectSubagentPanelRows(snapshot, {
      ...rootState,
      inspectedPath: scoutPath,
      openChildPaths: [workerPath],
      selectedView: { kind: 'child', path: workerPath },
    });

    expect(rows.map((row) => row.path)).not.toContainEqual([]);

    const worker = rows.find((row) => row.path.join('/') === 'worker');
    const scout = rows.find((row) => row.path.join('/') === 'worker/scout');
    expect(worker).toBeDefined();
    expect(scout).toBeDefined();

    expect(worker).toMatchObject({
      label: 'worker',
      depth: 0,
      viewOpen: true,
      inspected: false,
      openAction: 'show',
      metadata: expect.objectContaining({
        persona: 'reviewer',
        model: 'provider/model',
        state: 'running',
        contextPercent: 31,
        usage: { costUsd: 0.04 },
      }),
    });
    expect(scout).toMatchObject({
      label: 'scout',
      depth: 1,
      viewOpen: false,
      inspected: true,
      openAction: 'open',
      metadata: expect.objectContaining({ state: 'waiting', waitingTargets: [workerPath] }),
    });
  });
});
