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
    cwd: path.length === 1 ? '/workspace' : '/workspace/scout',
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
    lastOutput: 'Callback ownership confirmed.',
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
    rootCwd: '/workspace',
    nodes: [node(['worker']), node(['worker', 'scout'])],
  });
  sessionRegistry.handleEvent({
    type: 'subagent_view_snapshot',
    sessionId: 'root',
    childSessionId: 'child-worker',
    path: ['worker'],
    incarnation: 'inc-worker',
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
  sessionRegistry.setDraftText(sessionRegistry.getSubagentAttachment('root', ['worker'])!.sessionId, 'Child draft');
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
    expect(mainCommand?.querySelector('dt')).toBeNull();
    expect(mainCommand?.querySelector('dd')?.textContent).toContain('checking callback ownership');
    expect(mainCommand?.parentElement).toBe(mainRow);
    expect(mainRow?.querySelector('[data-folder-icon="persona"]')).not.toBeNull();
    const mainRowButton = mainRow?.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]');
    expect(mainRowButton?.getAttribute('aria-expanded')).toBe('false');
    expect(mainRowButton?.textContent?.match(/worker/g)).toHaveLength(1);
    expect(mainRowButton?.textContent).toContain('waiting');
    const mainContext = mainRow?.querySelector('.tree-row-meta');
    const mainOpenButton = mainRow?.querySelector('[data-open-node="worker"]');
    expect(mainContext?.textContent).toContain('31%');
    expect(mainOpenButton).not.toBeNull();
    expect(mainContext!.compareDocumentPosition(mainOpenButton!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(mainRow?.classList.contains('hover:bg-sidebar-accent/60')).toBe(true);
    expect(mainRowButton?.classList.contains('hover:bg-sidebar-accent/60')).toBe(false);

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const hierarchy = target.querySelector('[aria-label="Subagents"]')!;
    const details = target.querySelector('[aria-label="Selected subagent details"]')!;
    const nestedRow = target.querySelector<HTMLElement>('[data-node="worker/scout"]')!;
    expect(mainRowButton?.getAttribute('aria-expanded')).toBe('true');
    expect(details).not.toBeNull();
    expect(mainRow?.contains(details)).toBe(true);
    expect(mainRow!.compareDocumentPosition(nestedRow) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(hierarchy.querySelector('button[aria-label="Inspect worker/scout"]')).not.toBeNull();
    expect(target.querySelectorAll('[aria-label="Selected subagent details"]')).toHaveLength(1);
    expect(mainRow?.querySelector('dl.tree-row-command')).toBeNull();
    expect(details.textContent).not.toContain(initialTask);
    expect(details.textContent).not.toContain('reviewer');
    expect(details.textContent).not.toContain('Persona');
    expect(details.textContent).not.toContain('View closed');
    const viewLabel = [...details.querySelectorAll('.metadata-label')].find((label) => label.textContent === 'View');
    expect(viewLabel?.nextElementSibling?.textContent).toBe('open');
    expect(details.textContent).not.toContain('Working directory');
    expect(details.textContent).toContain('provider/review-model');
    const detailCommands = details.querySelectorAll('dl.agent-inspector-command');
    expect(detailCommands[0]?.querySelector('dt')?.textContent).toBe('Last command');
    expect(detailCommands[0]?.querySelector('dd')?.textContent).toContain('checking callback ownership');
    expect(detailCommands[1]?.querySelector('dt')?.textContent).toBe('Last output');
    expect(detailCommands[1]?.querySelector('dd code')?.textContent).toBe('Callback ownership confirmed.');
    const usage = details.querySelector('.agent-inspector-usage');
    expect(detailCommands[0]?.compareDocumentPosition(usage!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(details.textContent).toContain('parent');
    expect(details.textContent).toContain('worker/scout');
    expect(details.textContent).not.toContain('State');
    expect(details.textContent).not.toContain('Context');
    expect(details.textContent).toContain('Turns');
    expect(details.textContent).toContain('2');
    const breakdown = details.querySelector('[aria-label="Cost and token breakdown"]');
    expect(details.querySelector('button.cost-disclosure-trigger')).toBeNull();
    const expand = breakdown?.querySelector<HTMLButtonElement>('button[aria-label="Expand usage breakdown"]');
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    expect(breakdown?.querySelector('dl')).toBeNull();
    expect(breakdown?.textContent).not.toContain('Category');
    expect(breakdown?.textContent).not.toContain('Tokens');
    expect(breakdown?.textContent).not.toContain('Cost');
    const collapsedSummary = expand?.querySelector('[aria-label="Usage preview"]');
    const collapsedChevron = expand?.querySelector('.cost-breakdown-chevron');
    expect(collapsedSummary).not.toBeNull();
    expect(collapsedChevron).not.toBeNull();
    expect(collapsedSummary!.compareDocumentPosition(collapsedChevron!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')?.textContent).toContain('↑500');
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')?.textContent).toContain('↓200');
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')?.textContent).toContain('cache: 7.7%');
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')?.textContent).not.toContain('150');
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')?.textContent).toContain('4.00¢');
    expand?.click();
    await tick();
    expect(expand?.textContent).toContain('Category');
    expect(expand?.textContent).toContain('Tokens');
    expect(expand?.textContent).toContain('Cost');
    expect(expand?.querySelector('[aria-label="Usage preview"]')).toBeNull();
    expect(breakdown?.querySelector('dl')).not.toBeNull();
    expect(breakdown?.textContent).toContain('Input');
    expect(breakdown?.textContent).toContain('500 tok');
    expect(breakdown?.textContent).toContain('Output');
    expect(breakdown?.textContent).toContain('200 tok');
    expect(breakdown?.textContent).toContain('Cache read');
    expect(breakdown?.textContent).toContain('50 tok');
    expect(breakdown?.textContent).toContain('Cache write');
    expect(breakdown?.textContent).toContain('100 tok');
    expect(breakdown?.textContent).toContain('850 tok');
    expect(breakdown?.textContent).toContain('4.00¢');
    breakdown?.querySelector<HTMLButtonElement>('button[aria-label="Collapse usage breakdown"]')?.click();
    await tick();
    expect(breakdown?.querySelector('dl')).toBeNull();
    expect(breakdown?.querySelector('[aria-label="Usage preview"]')).not.toBeNull();
    expect(sessionRegistry.viewedSurface?.kind).toBe('root');

    mainRowButton?.click();
    await tick();
    expect(target.querySelector('[aria-label="Selected subagent details"]')).toBeNull();
    expect(mainRowButton?.getAttribute('aria-expanded')).toBe('false');
    expect(mainRow?.querySelector('dl.tree-row-command')).not.toBeNull();
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.messages[0].content[0]).toMatchObject({ type: 'text', text: initialTask });
  });

  it('collapses details for a child whose view is already selected without closing that view', async () => {
    sessionRegistry.selectSubagentView('root', ['worker']);
    const target = render();
    await tick();

    const row = target.querySelector<HTMLElement>('[data-node="worker"]')!;
    const inspectButton = row.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!;
    expect(inspectButton.getAttribute('aria-expanded')).toBe('true');
    const details = row.querySelector('[aria-label="Selected subagent details"]');
    expect(details).not.toBeNull();
    expect([...details!.querySelectorAll('.metadata-label')].some((label) => label.textContent === 'View')).toBe(true);
    expect(details?.textContent).not.toContain('View closed');

    inspectButton.click();
    await tick();

    expect(row.querySelector('[aria-label="Selected subagent details"]')).toBeNull();
    expect(inspectButton.getAttribute('aria-expanded')).toBe('false');
    expect(sessionRegistry.viewedSurface?.kind).toBe('child');
    expect(sessionRegistry.getSelectedSubagentPath('root')).toEqual(['worker']);
  });

  it('previews tokens when collapsed and shows their rows when category costs are missing', async () => {
    const worker = node(['worker']);
    const workerWithoutCostBreakdown: SubagentNodeSnapshot = {
      ...worker,
      usage: {
        input: worker.usage.input,
        output: worker.usage.output,
        cacheRead: worker.usage.cacheRead,
        cacheWrite: worker.usage.cacheWrite,
        cost: worker.usage.cost,
        turns: worker.usage.turns,
      },
    };
    sessionRegistry.handleEvent({
      type: 'subagent_snapshot',
      sessionId: 'root',
      cursor: { epoch: 'epoch-1', sequence: 2 },
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      activeOperations: [],
      nodes: [workerWithoutCostBreakdown, node(['worker', 'scout'])],
    });
    const target = render();
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const breakdown = target.querySelector('[aria-label="Cost and token breakdown"]');
    const preview = breakdown?.querySelector('[aria-label="Usage preview"]');
    expect(preview?.textContent).toContain('↑500');
    expect(preview?.textContent).toContain('↓200');
    expect(preview?.textContent).toContain('cache: 7.7%');
    expect(preview?.textContent).toContain('4.00¢');
    const expand = breakdown?.querySelector<HTMLButtonElement>('button[aria-label="Expand usage breakdown"]');
    expand?.click();
    await tick();
    expect(breakdown?.textContent).toContain('500 tok');
    expect(breakdown?.textContent).toContain('200 tok');
    expect(breakdown?.textContent).toContain('50 tok');
    expect(breakdown?.textContent).toContain('100 tok');
    expect(breakdown?.textContent).toContain('Category costs unavailable');
    expect(target.querySelector('button.cost-disclosure-trigger')).toBeNull();
  });

  it('shows a working directory only when it differs from the parent agent', async () => {
    const target = render();
    await tick();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();
    let details = target.querySelector('[aria-label="Selected subagent details"]')!;
    expect(details.textContent).not.toContain('Working directory');

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker/scout"]')!.click();
    await tick();
    details = target.querySelector('[aria-label="Selected subagent details"]')!;
    const directoryLabel = [...details.querySelectorAll('.metadata-label')].find((label) => label.textContent === 'Working directory');
    expect(directoryLabel?.nextElementSibling?.textContent).toBe('/workspace/scout');
    expect(directoryLabel?.nextElementSibling?.getAttribute('title')).toBe('/workspace/scout');
  });

  it('hides the waits field when the agent has no wait targets', async () => {
    const worker = node(['worker']);
    sessionRegistry.handleEvent({
      type: 'subagent_snapshot',
      sessionId: 'root',
      cursor: { epoch: 'epoch-1', sequence: 2 },
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      activeOperations: [],
      nodes: [{ ...worker, waitingFor: [] }, node(['worker', 'scout'])],
    });
    const target = render();
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const details = target.querySelector('[aria-label="Selected subagent details"]');
    expect(details?.textContent).not.toContain('Waits');
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
    target.querySelector<HTMLButtonElement>('[data-node="worker"] button[aria-label="Show worker view"]')!.click();
    await tick();
    expect(sessionRegistry.viewedSurface?.kind).toBe('child');
    expect(sessionRegistry.getSubagentAttachment('root', ['worker'])?.draftText).toBe('Child draft');
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

  it('keeps view actions in the main row and teardown in inspected details', async () => {
    const target = render();
    await tick();

    expect(target.querySelector('[data-node="worker"] button[aria-label="Show worker view"]')).not.toBeNull();
    expect(target.querySelector('[data-node="worker"] button[aria-label="Teardown worker"]')).toBeNull();
    expect(target.querySelector('[aria-label="Selected subagent details"]')).toBeNull();

    target.querySelector<HTMLButtonElement>('button[aria-label="Inspect worker"]')!.click();
    await tick();

    const details = target.querySelector('[aria-label="Selected subagent details"]');
    expect(details?.querySelector('button[aria-label="Show worker view"]')).toBeNull();
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
    expect(target.querySelector('[data-node="worker"] button[aria-label="Open worker view"]')).not.toBeNull();
    expect(details?.querySelector('button[aria-label="Open worker view"]')).toBeNull();
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

    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent_teardown', sessionId: 'root', path: ['worker'], incarnation: 'inc-worker' }));
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

describe('Panel tree identity menu', () => {
  it('copies a child session id from the desktop row menu', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const target = render();
    await tick();

    const row = target.querySelector<HTMLElement>('[data-node="worker"]');
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await tick();

    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [data-slot="context-menu-item"]')].find(
      (candidate) => candidate.textContent?.trim() === 'Copy session ID',
    );
    expect(item).not.toBeUndefined();
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('child-worker'));
  });
});
