// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import type { AgentPath, PimoteAgentMessage, PimoteMessageContent, PimoteSubagentFinalData, PimoteSubagentStartData, SubagentNodeSnapshot } from '@pimote/shared';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import Message from './Message.svelte';

type SubagentContent = Extract<PimoteMessageContent, { type: 'subagent' }>;
type SubagentKind = SubagentContent['subagentKind'];
type SubagentState = SubagentContent['subagentState'];
let component: ReturnType<typeof mount> | undefined;

const chipStateRoot = 'chip-state-root';

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  sessionRegistry.clearSubagentRoot(chipStateRoot);
  delete sessionRegistry.sessions[chipStateRoot];
  sessionRegistry.viewedSessionId = null;
  document.body.replaceChildren();
});

function operation(
  data: PimoteSubagentStartData | PimoteSubagentFinalData,
  subagentState: SubagentState = 'complete',
  subagentKind: SubagentKind = data.operation === 'protocol_error' ? 'protocol_error' : data.operation,
): SubagentContent {
  return {
    type: 'subagent',
    operationId: 'operation-call',
    subagentKind,
    subagentState,
    subagentPath: ['team'],
    placement: { toolCallId: 'operation-call', contentIndex: 1 },
    data,
  };
}

function mixedMessage(block: SubagentContent): PimoteAgentMessage {
  return {
    role: 'assistant',
    entryId: 'assistant-entry',
    content: [
      { type: 'text', text: 'I will ask the worker.' },
      block,
      { type: 'text', text: 'I will inspect the local file too.' },
      { type: 'tool_call', toolCallId: 'read-call', toolName: 'read', args: { path: 'config.json' } },
    ],
  };
}

async function render(block: SubagentContent, options: { custom?: boolean; rootSessionId?: string; agentPath?: AgentPath } = {}) {
  const { custom = false, rootSessionId = '', agentPath } = options;
  const messages = writable<PimoteAgentMessage>(custom ? { role: 'custom', content: [block] } : mixedMessage(block));
  const current = fromStore(messages);
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(Message, {
    target,
    props: {
      get message() {
        return current.current;
      },
      subagentRootSessionId: rootSessionId,
      agentPath,
    },
  });
  await tick();
  return {
    target,
    async update(next: SubagentContent) {
      messages.set(custom ? { role: 'custom', content: [next] } : mixedMessage(next));
      await tick();
    },
  };
}

async function renderAssistantBlocks(blocks: readonly SubagentContent[]) {
  const messages = writable<PimoteAgentMessage>({ role: 'assistant', entryId: 'assistant-entry', content: [...blocks] });
  const current = fromStore(messages);
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(Message, {
    target,
    props: {
      get message() {
        return current.current;
      },
    },
  });
  await tick();
  return { target };
}

function card(target: HTMLElement, kind: SubagentKind): HTMLElement {
  const element = target.querySelector<HTMLElement>(`[data-subagent-kind="${kind}"]`);
  expect(element, `The ${kind} card is rendered`).not.toBeNull();
  return element!;
}

function section(target: Element, label: string): HTMLElement {
  const value = [...target.querySelectorAll<HTMLElement>('[aria-label]')].find((entry) => entry.getAttribute('aria-label') === label);
  expect(value, `The ${label} section is rendered`).toBeDefined();
  return value!;
}

describe('subagent transcript cards', () => {
  it('uses the tool-call header with active, success, failure, and duration states', async () => {
    const active = operation(
      { operation: 'send', parameters: { to: ['team', 'worker'], message: 'Check the config.', expectResponse: true }, result: { response: '', phase: 'waiting' } },
      'active',
    );
    const { target, update } = await render(active);
    const activeCard = card(target, 'send');
    expect(activeCard.querySelector('[aria-label="Response"]')).toBeNull();
    expect(activeCard.querySelector('.subagent-name')?.textContent).toBe('send');
    expect(activeCard.querySelector('.subagent-state-icon.spinning')).not.toBeNull();
    expect(activeCard.querySelector('.subagent-status')?.textContent).toContain('waiting');
    expect(activeCard.querySelector('.subagent-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(activeCard.querySelector('.agent-chip[data-agent-path="team/worker"]')).not.toBeNull();

    await update(
      operation(
        {
          operation: 'send',
          parameters: { to: ['team', 'worker'], message: 'Check the config.', expectResponse: true },
          result: { response: 'The config is valid.', phase: 'responding' },
        },
        'active',
      ),
    );
    expect(card(target, 'send').querySelector('[aria-label="Response"]')).not.toBeNull();

    const { target: completeTarget } = await render({
      ...operation({ operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } }),
      durationMs: 1250,
    });
    const completeCard = card(completeTarget, 'send');
    expect(completeCard.querySelector('.subagent-state-icon.succeeded')).not.toBeNull();
    expect(completeCard.querySelector('.subagent-status')?.textContent).toContain('1s');

    const { target: failedTarget } = await render(operation({ operation: 'protocol_error', result: { error: 'bad request' } }, 'protocol_error'));
    expect(card(failedTarget, 'protocol_error').querySelector('.subagent-state-icon.failed')).not.toBeNull();
  });

  it('shows the failure text of a failed tool call on every operation card', async () => {
    const failures: readonly Readonly<{ data: PimoteSubagentFinalData; error: string }>[] = [
      { data: { operation: 'delegation', parameters: {}, result: { children: [], error: 'Persona "nope" not found.' } }, error: 'Persona "nope" not found.' },
      { data: { operation: 'interrupt', parameters: {}, result: { interrupted: [], pending: [], failed: [], error: 'No agent matched.' } }, error: 'No agent matched.' },
      { data: { operation: 'teardown', parameters: {}, result: { affectedAgents: [], status: 'not_found', error: 'Agent is gone.' } }, error: 'Agent is gone.' },
      { data: { operation: 'resurrect', parameters: {}, result: { affectedAgents: [], error: 'Session expired.' } }, error: 'Session expired.' },
    ];
    for (const { data, error } of failures) {
      const { target } = await render(operation(data, 'error'));
      const rendered = card(target, data.operation);
      expect(rendered.querySelector('.subagent-state-icon.failed'), `${data.operation} marks the failure`).not.toBeNull();
      expect(section(rendered, 'Error').textContent, `${data.operation} shows the failure text`).toContain(error);
    }
    const { target: bareTarget } = await render(operation({ operation: 'delegation', parameters: {}, result: { children: [] } }, 'error'));
    expect(card(bareTarget, 'delegation').querySelector('.subagent-failure-note')?.textContent).toContain('failed without an error message');
  });

  it('names the child agent in the assistant avatar slot', async () => {
    const { target } = await render(operation({ operation: 'send', parameters: { to: ['worker'], message: 'check' }, result: { response: 'done' } }), {
      rootSessionId: 'root-session',
      agentPath: ['team', 'worker'],
    });
    const chips = [...target.querySelectorAll<HTMLElement>('[data-agent-leading="bot"]')];
    expect(chips).toHaveLength(1);
    expect(chips[0].dataset.agentPath).toBe('team/worker');
    expect(target.querySelector('.assistant-speaker')).toBeNull();
  });

  it('streams delegation tasks as bounded Markdown and offers a view without stale child status', async () => {
    const { target, update } = await render(
      operation(
        {
          operation: 'delegation',
          parameters: {},
          result: { children: [{ path: ['team', 'worker'], task: 'Review **config', persona: 'scout' }] },
        },
        'active',
      ),
      { rootSessionId: 'root-session' },
    );
    const spawnCard = card(target, 'delegation');
    const task = spawnCard.querySelector('.subagent-text-section');
    expect(task).not.toBeNull();
    expect(task?.getAttribute('aria-label')).toBeNull();
    expect(spawnCard.querySelector('.tool-section-label')).toBeNull();
    expect(task?.textContent).toContain('confi');
    expect(task?.querySelector('.code-block[data-mode="markdown"]')).not.toBeNull();
    const chip = spawnCard.querySelector<HTMLElement>('[data-agent-path="team/worker"]');
    expect(chip?.getAttribute('aria-label')).toBe('scout:worker');
    expect(chip?.querySelector('[data-persona-icon] svg')).not.toBeNull();
    expect(chip?.querySelector('.agent-chip-status:not(.agent-chip-persona)')).toBeNull();
    expect(spawnCard.querySelector('.subagent-view-button')?.getAttribute('aria-label')).toBe('Open team/worker view');
    expect(spawnCard.querySelector('.subagent-body')?.textContent).not.toContain('running');

    await update(
      operation({
        operation: 'delegation',
        parameters: { agents: [{ id: 'worker' }] },
        result: { children: [{ path: ['team', 'worker'], task: 'Review **configuration** and run `tests`.', persona: 'scout' }] },
      }),
    );
    const completedTask = card(target, 'delegation').querySelector('.subagent-text-section');
    expect(completedTask?.querySelector('strong')?.textContent).toBe('configuration');
    expect(completedTask?.querySelector('code')?.textContent).toBe('tests');
  });

  it('keeps a settled spawn card folded when its data updates', async () => {
    let emit: ((entries: readonly IntersectionObserverEntry[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: readonly IntersectionObserverEntry[]) => void) {
          emit = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const delegation = (task: string): SubagentContent => operation({ operation: 'delegation', parameters: {}, result: { children: [{ path: ['team', 'worker'], task }] } });
    const { target, update } = await render(delegation('Review the config.'));
    expect(card(target, 'delegation').querySelector('.subagent-body')).not.toBeNull();

    // The reader scrolled the settled card out of view: it folds.
    emit?.([{ isIntersecting: true } as IntersectionObserverEntry]);
    emit?.([{ isIntersecting: false } as IntersectionObserverEntry]);
    await tick();
    expect(card(target, 'delegation').querySelector('.subagent-body')).toBeNull();

    // A projection event replaces the block object with the same operation.
    await update(delegation('Review the config and the tests.'));

    expect(card(target, 'delegation').querySelector('.subagent-body')).toBeNull();
  });

  it('keeps a settled custom-message card open when it scrolls out of view', async () => {
    let emit: ((entries: readonly IntersectionObserverEntry[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: readonly IntersectionObserverEntry[]) => void) {
          emit = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const received = {
      ...operation({ operation: 'send', result: { from: ['team', 'worker'], to: [], message: 'Status **update**.' } }, 'complete', 'message_received'),
      placement: { entryId: 'custom-entry' } as const,
    };
    const { target } = await render(received, { custom: true });
    const messageCard = card(target, 'message_received');
    expect(messageCard.querySelector('.subagent-name')?.textContent).toBe('message');
    expect(messageCard.querySelector('.subagent-body')).not.toBeNull();

    // The reader scrolled the settled card out of view: it stays open.
    emit?.([{ isIntersecting: true } as IntersectionObserverEntry]);
    emit?.([{ isIntersecting: false } as IntersectionObserverEntry]);
    await tick();
    expect(card(target, 'message_received').querySelector('.subagent-body')).not.toBeNull();

    // The reader can still fold it.
    messageCard.querySelector<HTMLButtonElement>('.subagent-header')?.click();
    await tick();
    expect(card(target, 'message_received').querySelector('.subagent-body')).toBeNull();
  });

  it('bounds long spawn tasks and offers show-more', async () => {
    const task = Array.from({ length: 25 }, (_, index) => `Task line ${index + 1}`).join('\n');
    const { target } = await render(
      operation({
        operation: 'delegation',
        parameters: {},
        result: { children: [{ path: ['worker'], task }] },
      }),
    );
    const showMore = Array.from(card(target, 'delegation').querySelectorAll('button')).find((button) => button.textContent?.includes('Show more'));
    expect(showMore).toBeDefined();
  });

  it('uses one bounded Markdown section for awaited output after completion or message interruption', async () => {
    const parameters = { agents: [['team', 'worker']] };
    const output = 'Deployment is **healthy**.\n\n- New process started\n- No failed units';
    const active = operation({ operation: 'await', parameters, result: { statuses: [] } }, 'active');
    const { target: activeTarget } = await render(active);
    const activeCard = card(activeTarget, 'await');
    expect(activeCard.querySelector('[data-agent-path="team/worker"]')).not.toBeNull();
    expect(activeCard.textContent).toContain('Waiting');

    const completed = operation({ operation: 'await', parameters, result: { statuses: [{ path: ['team', 'worker'], state: 'idle', output }] } });
    const { target: completedTarget } = await render(completed);
    const completedCard = card(completedTarget, 'await');
    expect(completedCard.querySelector('.tool-section-label')).toBeNull();
    expect(completedCard.querySelector('.subagent-status')?.textContent).toContain('completed');
    expect(section(completedCard, 'Output').querySelector('strong')?.textContent).toBe('healthy');
    expect(section(completedCard, 'Output').querySelectorAll('li')).toHaveLength(2);

    const interrupted = operation(
      {
        operation: 'await',
        parameters,
        result: { statuses: [{ path: ['team', 'worker'], state: 'running', output }], interrupted: true },
      },
      'aborted',
    );
    const { target: interruptedTarget } = await render(interrupted);
    const interruptedCard = card(interruptedTarget, 'await');
    expect(interruptedCard.querySelector('.subagent-state-icon[aria-label="Interrupted"]')).not.toBeNull();
    expect(interruptedCard.querySelector('.subagent-status')?.textContent).toContain('interrupted');
    expect(section(interruptedCard, 'Output').querySelector('strong')?.textContent).toBe('healthy');
    expect(section(interruptedCard, 'Output').querySelectorAll('li')).toHaveLength(2);
  });

  it('shows an incoming interruption inside its await card', async () => {
    const awaitBlock = {
      ...operation(
        { operation: 'await', parameters: { agents: [['team', 'worker']] }, result: { statuses: [{ path: ['team', 'worker'], state: 'running' }], interrupted: true } },
        'aborted',
      ),
      operationId: 'await-call',
      placement: { toolCallId: 'await-call', contentIndex: 0, entryId: 'assistant-entry' } as const,
    };
    const incoming = {
      ...operation(
        { operation: 'send', result: { from: ['team', 'worker'], to: [], message: 'Please **review** the failure.', responseExpected: false } },
        'complete',
        'message_received',
      ),
      operationId: 'incoming-message',
      placement: { toolCallId: 'await-call', contentIndex: 0, entryId: 'await-result' } as const,
    };

    const { target } = await renderAssistantBlocks([awaitBlock, incoming]);
    const awaitCard = card(target, 'await');
    const messages = section(awaitCard, 'Messages');

    expect(messages.querySelector('strong')?.textContent).toBe('review');
    expect(target.querySelector('[data-subagent-kind="message_received"]')).toBeNull();
  });

  it('separates an expected send response from its message', async () => {
    const { target, update } = await render(
      operation({
        operation: 'send',
        parameters: { to: ['team', 'worker'], message: 'Check **settings**.', expectResponse: true },
        result: { response: 'The settings are `valid`.', phase: 'responding' },
      }),
    );
    const sendCard = card(target, 'send');
    expect(section(sendCard, 'Response').classList.contains('subagent-text-section-separated')).toBe(true);

    await update(operation({ operation: 'send', parameters: { to: ['team', 'worker'], message: 'Send an update.' }, result: { response: 'Delivered.' } }));
    expect(section(card(target, 'send'), 'Response').classList.contains('subagent-text-section-separated')).toBe(false);
  });

  it('renders all message text through the streaming Markdown renderer', async () => {
    const send = operation(
      {
        operation: 'send',
        parameters: { to: ['team', 'worker'], message: 'Check **settings**.' },
        result: { response: 'The settings are `valid`.', phase: 'responding' },
      },
      'active',
    );
    const { target, update } = await render(send);
    const sendCard = card(target, 'send');
    expect(sendCard.querySelector('.tool-section-label')).toBeNull();
    expect(section(sendCard, 'Message').querySelector('strong')?.textContent).toBe('settings');
    expect(section(sendCard, 'Response').querySelector('code')?.textContent).toBe('valid');
    await update(operation({ operation: 'send', parameters: { to: ['team', 'worker'], message: 'Final **request**.' }, result: { response: 'Final *reply*.' } }));
    expect(section(card(target, 'send'), 'Message').querySelector('strong')?.textContent).toBe('request');
    expect(section(card(target, 'send'), 'Response').querySelector('em')?.textContent).toBe('reply');
  });

  it('renders replies with the owner AgentChip and bounded Markdown', async () => {
    const respond = operation({ operation: 'respond', parameters: { message: 'All **clear**.' }, result: { message: 'Delivered.' } });
    const { target } = await render(respond);
    const respondCard = card(target, 'respond');
    expect(respondCard.querySelector('.subagent-name')?.textContent).toBe('response');
    expect(respondCard.querySelector('.tool-section-label')).toBeNull();
    expect(respondCard.querySelector('[data-agent-path="team"]')).not.toBeNull();
    expect(respondCard.querySelector('.subagent-status')?.textContent).toContain('replied');
    expect(section(respondCard, 'Reply').querySelector('strong')?.textContent).toBe('clear');
    expect(section(respondCard, 'Result').textContent).toContain('Delivered');
  });

  it('renders incoming message sender as an AgentChip and message body as Markdown', async () => {
    const incoming = operation(
      { operation: 'send', result: { from: ['team', 'worker'], to: [], message: 'Please **check** the `config`.', responseExpected: true } },
      'complete',
      'message_received',
    );
    const { target } = await render(incoming, { custom: true, rootSessionId: 'root-session' });
    const messageCard = card(target, 'message_received');
    expect(messageCard.querySelector('.subagent-name')?.textContent).toBe('request');
    expect(messageCard.querySelector('.tool-section-label')).toBeNull();
    expect(messageCard.querySelector('[data-agent-path="team/worker"]')).not.toBeNull();
    expect(section(messageCard, 'Message').querySelector('strong')?.textContent).toBe('check');
    expect(section(messageCard, 'Message').querySelector('code')?.textContent).toBe('config');
    expect(messageCard.textContent).toContain('Response expected');
  });

  it('renders teardown rows with agent identity and usage, without output fields', async () => {
    const teardown = operation({
      operation: 'teardown',
      parameters: { agent: ['team', 'worker'] },
      result: {
        status: 'removed',
        affectedAgents: [
          {
            path: ['team', 'worker'],
            sessionId: 'saved-session',
            incarnation: 'incarnation-2',
            state: 'idle',
            usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.015, turns: 2 },
          },
        ],
      },
    });
    const { target } = await render(teardown, { custom: true, rootSessionId: 'root-session' });
    const teardownCard = card(target, 'teardown');
    expect(teardownCard.querySelector('[data-agent-path="team/worker"]')?.textContent).toContain('worker');
    expect(teardownCard.textContent).toContain('$0.0150');
    expect(teardownCard.querySelector('[aria-label="Output"]')).toBeNull();
    expect(teardownCard.querySelector('[aria-label="Error"]')).toBeNull();
    expect(teardownCard.textContent).not.toContain('saved-session');
    expect(teardownCard.textContent).not.toContain('incarnation-2');
  });

  it('offers resurrection from a tool teardown card', async () => {
    const teardown = operation(
      {
        operation: 'teardown',
        parameters: { agent: ['team', 'worker'] },
        result: {
          status: 'removed',
          affectedAgents: [
            {
              path: ['team', 'worker'],
              sessionId: 'saved-session',
              incarnation: 'incarnation-2',
              state: 'idle',
              task: 'Continue the review',
              channels: ['parent', 'scout'],
              model: 'provider/model',
              usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.015, turns: 2 },
            },
          ],
        },
      },
      'complete',
    );
    const { target } = await render(teardown, { rootSessionId: chipStateRoot });
    const resurrect = card(target, 'teardown').querySelector<HTMLButtonElement>('[aria-label="Resurrect team/worker"]');

    expect(resurrect).not.toBeNull();
    resurrect!.click();
    await tick();
    const pending = sessionRegistry.getPendingSubagentResurrection(chipStateRoot);
    expect(pending?.path).toEqual(['team', 'worker']);
    expect(pending?.resurrection).toEqual({
      savedSessionId: 'saved-session',
      task: 'Continue the review',
      channels: ['parent', 'scout'],
      model: 'provider/model',
    });
  });

  it('renders and offers resurrection for a user teardown custom message', async () => {
    const teardown = {
      ...operation({ operation: 'teardown', parameters: { agent: ['team', 'worker'] }, result: { status: 'removed', affectedAgents: [] } }),
      placement: { entryId: 'custom-teardown' } as const,
    };
    const { target } = await render(teardown, { custom: true, rootSessionId: chipStateRoot });
    const teardownCard = card(target, 'teardown');
    const resurrect = teardownCard.querySelector<HTMLButtonElement>('[aria-label="Resurrect team/worker"]');

    expect(teardownCard.querySelector('[data-agent-path="team/worker"]')).not.toBeNull();
    expect(resurrect).not.toBeNull();
    resurrect!.click();
    await tick();
    expect(sessionRegistry.getPendingSubagentResurrection(chipStateRoot)?.path).toEqual(['team', 'worker']);
  });

  it('shows a view action, session identity, and bounded output on resurrection', async () => {
    const resurrect = operation({
      operation: 'resurrect',
      parameters: { agents: [{ id: 'worker', sessionId: 'saved-session', task: 'continue', channels: ['parent'] }] },
      result: {
        affectedAgents: [
          {
            path: ['team', 'worker'],
            sessionId: 'saved-session',
            incarnation: 'incarnation-2',
            state: 'idle',
            usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.015, turns: 2 },
            output: 'The `review` is **done**.',
          },
        ],
      },
    });
    const { target } = await render(resurrect, { custom: true, rootSessionId: 'root-session' });
    const resurrectCard = card(target, 'resurrect');
    expect(resurrectCard.querySelector('.tool-section-label')).toBeNull();
    expect(resurrectCard.querySelector('.subagent-view-button')?.getAttribute('aria-label')).toBe('Open team/worker view');
    expect(resurrectCard.textContent).toContain('saved-session');
    expect(section(resurrectCard, 'Output').querySelector('code')?.textContent).toBe('review');
    expect(section(resurrectCard, 'Output').querySelector('strong')?.textContent).toBe('done');
  });

  it('renders completion identity, output, errors, and usage', async () => {
    const completion = operation({
      operation: 'completion',
      result: {
        state: 'idle',
        output: 'The **deploy** passed.',
        usage: { input: 101, output: 202, cacheRead: 303, cacheWrite: 404, cost: 0.125, turns: 3, costBreakdown: { input: 0.01, output: 0.1, cacheRead: 0.005, cacheWrite: 0.01 } },
      },
    });
    const { target } = await render(completion);
    const completionCard = card(target, 'completion');
    expect(completionCard.querySelector('[data-agent-path="team"]')).not.toBeNull();
    const completionOutput = completionCard.querySelector('.subagent-text-section');
    expect(completionOutput?.getAttribute('aria-label')).toBeNull();
    expect(completionOutput?.querySelector('strong')?.textContent).toBe('deploy');
    expect(completionCard.matches('[data-subagent-kind="completion"]')).toBe(true);
    expect(completionCard.textContent).toContain('cache: 37.5%');
    expect(completionCard.textContent).toContain('$0.1250');
  });

  it('uses current hierarchy state for transcript chips and turns removed agents gray', async () => {
    const path: AgentPath = ['team', 'worker'];
    const liveNode: SubagentNodeSnapshot = {
      path,
      incarnation: 'live-incarnation',
      sessionId: 'live-child-session',
      state: 'running',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      channels: [],
      waitingFor: [],
      hasSubgroup: false,
    };
    sessionRegistry.addSession(chipStateRoot, '/workspace', 'workspace');
    sessionRegistry.handleEvent({
      type: 'subagent_snapshot',
      sessionId: chipStateRoot,
      cursor: { epoch: 'chip-state-epoch', sequence: 1 },
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      activeOperations: [],
      nodes: [liveNode],
    });

    const awaited = operation({ operation: 'await', parameters: { agents: [path] }, result: { statuses: [{ path, state: 'idle' }] } });
    const { target } = await render(awaited, { rootSessionId: chipStateRoot });
    const chips = [...target.querySelectorAll<HTMLElement>('[data-agent-path="team/worker"]')];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.dataset.agentState === 'running')).toBe(true);

    sessionRegistry.handleEvent({
      type: 'subagent_event',
      sessionId: chipStateRoot,
      cursor: 2,
      eventId: 'remove-live-child',
      path,
      kind: 'node_removed',
      data: { node: { ...liveNode, state: 'idle' }, reason: 'manual' },
      relatedPiEvents: [],
    });
    await tick();

    expect(chips.every((chip) => chip.dataset.agentState === 'unknown')).toBe(true);
  });

  it('renders interrupt outcomes as agent rows with bounded error content', async () => {
    const interrupt = operation({
      operation: 'interrupt',
      parameters: { agents: [['team', 'worker']] },
      result: {
        interrupted: [{ path: ['team', 'worker'], output: 'Stopped at **checkpoint**.' }],
        pending: [{ path: ['slow'], output: '`Still running`' }],
        failed: [{ path: ['gone'], error: '**Missing runtime**' }],
      },
    });
    const { target } = await render(interrupt, { custom: true, rootSessionId: 'root-session' });
    const interruptCard = card(target, 'interrupt');
    expect(interruptCard.querySelector('.tool-section-label')).toBeNull();
    expect(interruptCard.querySelector('[data-agent-path="team/worker"]')).not.toBeNull();
    expect(section(interruptCard, 'Output').querySelector('strong')?.textContent).toBe('checkpoint');
    expect(section(interruptCard, 'Error').querySelector('strong')?.textContent).toBe('Missing runtime');
    expect(interruptCard.querySelector('.subagent-status')?.textContent).toContain('partially failed');
  });
});
