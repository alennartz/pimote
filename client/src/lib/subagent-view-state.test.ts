import { describe, expect, it } from 'vitest';
import { projectSubagentPanelRows, reduceSubagentPanelState, type AgentPath, type SubagentPanelSnapshot, type SubagentPanelState } from './subagent-view-state.js';

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
      pendingCorrelations: ['corr-17'],
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
      pendingCorrelations: ['corr-17'],
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

  it('closes the selected child view and returns the conversation to the root', () => {
    const childState: SubagentPanelState = {
      inspectedPath: workerPath,
      openChildPaths: [workerPath, scoutPath],
      selectedView: { kind: 'child', path: workerPath },
    };

    const state = reduceSubagentPanelState(childState, { type: 'close_child_view' });

    expect(state.selectedView).toEqual({ kind: 'root' });
    expect(state.openChildPaths).toEqual([scoutPath]);
  });

  it('projects metadata and open markers without adding the root to the hierarchy', () => {
    const rows = projectSubagentPanelRows(snapshot, {
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
