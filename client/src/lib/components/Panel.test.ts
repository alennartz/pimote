// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteResponse } from '@pimote/shared';
import Panel from './Panel.svelte';
import { panelStore } from '$lib/stores/panel-store.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import type { SubagentNodeSnapshot } from '@pimote/shared';

// Panel imports the session registry, whose command paths flow through the
// connection. Mock it so teardown outcomes stay observable without a socket.
vi.mock('$lib/stores/connection.svelte.js', () => {
  const base: Record<string, unknown> = { status: 'connected', send: vi.fn(async () => ({ success: true, data: {} }) as PimoteResponse) };
  const connection = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      const fn = vi.fn();
      target[prop] = fn;
      return fn;
    },
  });
  return { connection, isSessionNotFoundError: () => false };
});

const { connection } = await import('$lib/stores/connection.svelte.js');

const rootName = 'Root conversation';
const initialTask = 'Initial delegation task.';
let destroy: (() => Promise<void>) | undefined;

function node(path: readonly string[]): SubagentNodeSnapshot {
  return {
    path,
    sessionId: `child-${path.join('/')}`,
    incarnation: `inc-${path.join('/')}`,
    task: initialTask,
    persona: 'reviewer',
    model: 'provider/review-model',
    thinkingLevel: 'high',
    state: 'waiting',
    activity: 'checking callback ownership',
    usage: {
      input: 500,
      output: 200,
      cacheRead: 50,
      cacheWrite: 100,
      cost: 0.04,
      costBreakdown: { input: 0.02, output: 0.01, cacheRead: 0.005, cacheWrite: 0.005 },
      turns: 2,
    },
    contextFill: 31,
    channels: ['parent', 'worker/scout'],
    waitingFor: [['worker', 'scout']],
    hasSubgroup: path.length === 1,
  };
}

function render(): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Panel, { target });
  destroy = () => unmount(component);
  return target;
}

function rootButton(target: HTMLElement): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>('button[aria-label="Show root session"]');
  expect(button).not.toBeNull();
  return button!;
}

function teardownButton(target: HTMLElement, path: string): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(`button[aria-label="Teardown ${path}"]`);
  expect(button).not.toBeNull();
  return button!;
}

beforeEach(() => {
  vi.clearAllMocks();
  panelStore.reset();
  panelStore.collapsed = false;
  panelStore.presentation = 'sidebar';
  panelStore.open = true;
  sessionRegistry.addSession('root', '/workspace', 'workspace');
  sessionRegistry.sessions.root.sessionName = rootName;
  sessionRegistry.switchTo('root');
  sessionRegistry.handleEvent({
    type: 'subagent_snapshot',
    sessionId: 'root',
    cursor: { epoch: 'epoch-1', sequence: 1 },
    manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
    activeOperations: [],
    nodes: [node(['worker']), node(['worker', 'scout'])],
  });
  sessionRegistry.handleEvent({
    type: 'subagent_view_snapshot',
    sessionId: 'root',
    childSessionId: 'child-worker',
    path: ['worker'],
    incarnation: 'inc-worker',
    attachmentGeneration: 'gen-worker',
    viewCursor: 1,
    state: {
      sessionId: 'child-worker',
      sessionFile: undefined,
      model: null,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      messageCount: 1,
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: initialTask }] }],
  });
  sessionRegistry.setSubagentDraftText('root', ['worker'], 'Child draft');
});

afterEach(async () => {
  await destroy?.();
  destroy = undefined;
  vi.useRealTimers();
  sessionRegistry.clearSubagentRoot('root');
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  panelStore.reset();
  panelStore.collapsed = false;
  panelStore.presentation = 'sidebar';
  panelStore.open = true;
  document.body.replaceChildren();
});

describe('Panel hierarchy navigation', () => {
  it('shows the root once without an empty inspector or task instructions', async () => {
    const target = render();
    await tick();

    expect(target.textContent?.split(rootName)).toHaveLength(2);
    expect(target.querySelector('[aria-label="Selected subagent details"]')).toBeNull();
    expect(target.textContent).not.toContain('Select a child');
  });

  it('inspects a child below the full tree without showing its initial task or switching the conversation', async () => {
    const target = render();
    await tick();
    expect(target.querySelector('button[aria-label="Inspect worker/scout"]')).not.toBeNull();
    const mainRow = target.querySelector<HTMLElement>('[data-node="worker"]');
    const mainCommand = mainRow?.querySelector('dl.tree-row-command');
    expect(mainCommand).not.toBeNull();
    expect(mainCommand?.querySelector('dt')?.textContent).toBe('Last command');
    expect(mainCommand?.querySelector('dd')?.textContent).toContain('checking callback ownership');
    expect(mainCommand?.parentElement).toBe(mainRow);
    expect(mainRow?.querySelector('[data-folder-icon="persona"]')).not.toBeNull();
    const mainRowButton = mainRow?.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]');
    expect(mainRowButton?.textContent?.match(/worker/g)).toHaveLength(1);
    expect(mainRowButton?.textContent).toContain('waiting');

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const hierarchy = target.querySelector('[aria-label="Subagents"]')!;
    const details = target.querySelector('[aria-label="Selected subagent details"]')!;
    expect(details).not.toBeNull();
    expect(hierarchy.contains(details)).toBe(false);
    expect(hierarchy.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(hierarchy.querySelector('button[aria-label="Inspect worker/scout"]')).not.toBeNull();
    expect(target.querySelectorAll('[aria-label="Selected subagent details"]')).toHaveLength(1);
    expect(details.textContent).not.toContain(initialTask);
    expect(details.textContent).toContain('reviewer');
    expect(details.textContent).not.toContain('Persona');
    expect(details.textContent).toContain('provider/review-model');
    const detailCommand = details.querySelector('dl.agent-inspector-command');
    expect(detailCommand).not.toBeNull();
    expect(detailCommand?.querySelector('dt')?.textContent).toBe('Last command');
    expect(detailCommand?.querySelector('dd')?.textContent).toContain('checking callback ownership');
    expect(details.textContent).toContain('parent');
    expect(details.textContent).toContain('worker/scout');
    const usage = details.querySelector('[aria-label="Subagent usage"]');
    expect(usage?.textContent).toContain('↑500');
    expect(usage?.textContent).toContain('↓200');
    expect(usage?.textContent).toContain('cache 150');
    expect(usage?.textContent).toContain('2 turns');
    const costTrigger = usage?.querySelector<HTMLButtonElement>('button.cost-disclosure-trigger');
    expect(costTrigger?.textContent?.trim()).toBe('4.00¢');
    costTrigger?.click();
    await tick();
    await tick();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Cache read');
    expect(sessionRegistry.viewedSurface?.kind).toBe('root');
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.messages[0].content[0]).toMatchObject({ type: 'text', text: initialTask });
  });

  it('hides the root row and section labels when the hierarchy has no children', async () => {
    sessionRegistry.handleEvent({
      type: 'subagent_snapshot',
      sessionId: 'root',
      cursor: { epoch: 'epoch-1', sequence: 2 },
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      activeOperations: [],
      nodes: [],
    });
    const target = render();
    await tick();

    expect(target.querySelector('button[aria-label="Show root session"]')).toBeNull();
    expect(target.querySelector('[aria-label="Subagents"]')).toBeNull();
    expect(target.textContent).not.toContain('Extensions');
  });

  it.each(['sidebar', 'drawer'] as const)('returns to the root from the %s without releasing the child', async (presentation) => {
    panelStore.setContainerWidth(presentation === 'drawer' ? 390 : 1120);
    panelStore.openPanel();
    sessionRegistry.selectSubagentView('root', ['worker']);
    const target = render();
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    rootButton(target).click();
    await tick();

    expect(sessionRegistry.viewedSurface?.kind).toBe('root');
    expect(sessionRegistry.viewedSessionId).toBe('root');
    expect(rootButton(target).getAttribute('aria-current')).toBe('page');
    expect(target.querySelector('[aria-label="Selected subagent details"]')).toBeNull();
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.closed).toBe(false);
    expect(panelStore.open).toBe(presentation === 'sidebar');

    if (presentation === 'drawer') panelStore.openPanel();
    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="Show worker view"]')!.click();
    await tick();
    expect(sessionRegistry.viewedSurface?.kind).toBe('child');
    expect(sessionRegistry.getSubagentDraftText('root', ['worker'])).toBe('Child draft');
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.messages[0].content[0]).toMatchObject({ type: 'text', text: initialTask });
  });
});

describe('Panel row teardown', () => {
  function openWorkerChildView(): void {
    sessionRegistry.handleEvent({
      type: 'subagent_view_snapshot',
      sessionId: 'root',
      childSessionId: 'child-worker',
      path: ['worker'],
      incarnation: 'inc-worker',
      attachmentGeneration: 'gen-worker',
      viewCursor: 1,
      state: {
        sessionId: 'child-worker',
        sessionFile: undefined,
        model: null,
        thinkingLevel: 'off',
        availableThinkingLevels: [],
        isStreaming: false,
        isCompacting: false,
        autoCompactionEnabled: true,
        messageCount: 1,
      },
      messages: [{ role: 'user', content: [{ type: 'text', text: initialTask }] }],
    });
    sessionRegistry.selectSubagentView('root', ['worker']);
  }

  function settleTeardown(): void {
    sessionRegistry.handleEvent({
      type: 'subagent_event',
      sessionId: 'root',
      cursor: 2,
      eventId: 'teardown-worker',
      path: ['worker'],
      kind: 'node_removed',
      data: { node: node(['worker']), reason: 'manual' },
      relatedPiEvents: [],
    });
  }

  it('keeps view and teardown actions in the inspected details', async () => {
    const target = render();
    await tick();

    expect(target.querySelector('[data-node="worker"] button[aria-label="Show worker view"]')).toBeNull();
    expect(target.querySelector('[data-node="worker"] button[aria-label="Teardown worker"]')).toBeNull();
    expect(target.querySelector('[aria-label="Selected subagent details"]')).toBeNull();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const details = target.querySelector('[aria-label="Selected subagent details"]');
    expect(details?.querySelector('button[aria-label="Show worker view"]')).not.toBeNull();
    expect(details?.querySelector('button[aria-label="Teardown worker"]')).not.toBeNull();
  });

  it('hides the teardown affordance on a dead inspected agent', async () => {
    sessionRegistry.handleEvent({
      type: 'subagent_event',
      sessionId: 'root',
      cursor: 2,
      eventId: 'worker-died',
      path: ['worker'],
      kind: 'node_updated',
      data: { ...node(['worker']), state: 'dead' },
      relatedPiEvents: [],
    });
    const target = render();
    await tick();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();
    expect(target.querySelector('[aria-label="Selected subagent details"] button[aria-label="Teardown worker"]')).toBeNull();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker/scout"]')!.click();
    await tick();
    expect(target.querySelector('[aria-label="Selected subagent details"] button[aria-label="Teardown worker/scout"]')).not.toBeNull();
  });

  it('interrupts an inspected child without opening its view', async () => {
    const target = render();
    await tick();
    await sessionRegistry.closeSubagentView('root', ['worker']);
    await tick();
    vi.mocked(connection.send).mockClear();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();
    const details = target.querySelector('[aria-label="Selected subagent details"]');
    expect(details?.querySelector('button[aria-label="Open worker view"]')).not.toBeNull();
    details?.querySelector<HTMLButtonElement>('button[aria-label="Interrupt worker"]')!.click();
    await tick();
    await Promise.resolve();

    expect(connection.send).toHaveBeenCalledWith({
      type: 'subagent_stop',
      sessionId: 'root',
      path: ['worker'],
      incarnation: 'inc-worker',
      expectedSessionId: 'child-worker',
    });
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.closed).toBe(true);
  });

  it('opens the confirmation dialog from the inspector and tears down on confirm', async () => {
    vi.mocked(connection.send).mockClear();
    openWorkerChildView();
    const target = render();
    await tick();

    teardownButton(target, 'worker').click();
    await tick();

    const dialog = target.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Teardown worker?');
    // The dialog names the row's child; the inspected view stays untouched.
    expect(sessionRegistry.getSelectedSubagentPath('root')).toEqual(['worker']);

    target.querySelector<HTMLButtonElement>('[role="alertdialog"] button[aria-label="Teardown worker"]')!.click();
    await tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent_teardown', sessionId: 'root', path: ['worker'], incarnation: 'inc-worker', attachmentGeneration: 'gen-worker' }),
    );
    settleTeardown();
    await tick();

    expect(target.querySelector('[aria-label="Teardown worker"]')).toBeNull();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(target.querySelector('[role="status"]')?.textContent).toContain('was removed.');
  });

  it('keeps the child when the row teardown is canceled', async () => {
    openWorkerChildView();
    const target = render();
    await tick();

    teardownButton(target, 'worker').click();
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();

    const cancel = [...target.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent?.trim() === 'Cancel');
    cancel!.click();
    await tick();

    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent_teardown' }));
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.closed).toBe(false);
  });
});

describe('Panel removal notices', () => {
  function removeWorkerNode(): void {
    sessionRegistry.handleEvent({
      type: 'subagent_event',
      sessionId: 'root',
      cursor: 2,
      eventId: 'remove-worker',
      path: ['worker'],
      kind: 'node_removed',
      data: { node: node(['worker']), reason: 'manual' },
      relatedPiEvents: [],
    });
  }

  it('auto-dismisses a removal notice after ten seconds and clears the persisted entry', async () => {
    vi.useFakeTimers();
    const target = render();
    await tick();

    removeWorkerNode();
    await tick();
    expect(target.querySelector('[role="status"]')?.textContent).toContain('was removed.');

    vi.advanceTimersByTime(5_000);
    await tick();
    expect(target.querySelector('[role="status"]')?.textContent).toContain('was removed.');

    vi.advanceTimersByTime(5_000);
    await tick();
    expect(target.querySelector('[role="status"]')).toBeNull();
    expect(sessionRegistry.getLatestSubagentClosedNotice('root')).toBeNull();
  });

  it('auto-dismisses an unavailable notice after ten seconds', async () => {
    vi.useFakeTimers();
    const target = render();
    await tick();

    sessionRegistry.handleEvent({
      type: 'subagent_view_closed',
      sessionId: 'root',
      path: ['worker'],
      incarnation: 'inc-worker',
      attachmentGeneration: 'gen-worker',
      reason: 'unavailable',
    });
    await tick();
    expect(target.querySelector('[role="status"]')?.textContent).toContain('is no longer available.');

    vi.advanceTimersByTime(10_000);
    await tick();
    expect(target.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps a resurrection request past ten seconds until dismissed', async () => {
    vi.useFakeTimers();
    const target = render();
    await tick();

    sessionRegistry.requestSubagentResurrection('root', ['worker']);
    await tick();
    expect(target.querySelector('[role="status"]')?.textContent).toContain('was removed.');

    vi.advanceTimersByTime(10_000);
    await tick();
    expect(target.querySelector('[role="status"]')).not.toBeNull();
    expect(sessionRegistry.getPendingSubagentResurrection('root')).not.toBeNull();
  });
});
