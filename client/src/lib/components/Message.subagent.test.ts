// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import type { PimoteAgentMessage, PimoteMessageContent, PimoteSubagentStartData, PimoteSubagentFinalData } from '@pimote/shared';
import Message from './Message.svelte';

type SubagentContent = Extract<PimoteMessageContent, { type: 'subagent' }>;
let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

function operation(data: PimoteSubagentStartData | PimoteSubagentFinalData, subagentState: SubagentContent['subagentState'] = 'complete'): SubagentContent {
  return {
    type: 'subagent',
    operationId: 'operation-call',
    subagentKind: data.operation === 'protocol_error' ? 'send' : data.operation,
    subagentState,
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

async function render(block: SubagentContent, custom = false) {
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

function card(target: HTMLElement, kind: string): HTMLElement {
  const label = kind === 'resurrect' ? 'Subagent resurrected' : kind === 'teardown' ? 'Subagent torn down' : `Subagent ${kind} operation`;
  const element = target.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return element!;
}

function field(target: Element, label: string): HTMLElement {
  const value = [...target.querySelectorAll<HTMLElement>('[aria-label]')].find((entry) => entry.getAttribute('aria-label') === label);
  expect(value, `The ${label} field is accessible`).toBeDefined();
  return value!;
}

function expectNumber(target: Element, label: string, expected: number): void {
  const text = field(target, label).textContent?.replace(/,/g, '') ?? '';
  const number = text.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)?.[0];
  expect(Number(number)).toBeCloseTo(expected, 6);
}

function expectBoolean(target: Element, label: string, expected: boolean): void {
  const text = field(target, label).textContent?.toLowerCase() ?? '';
  expect(text).toMatch(expected ? /\b(true|yes|enabled)\b/ : /\b(false|no|disabled)\b/);
}

function send(phase: 'ready' | 'sending' | 'waiting' | 'responding' | 'complete'): SubagentContent {
  const message = phase === 'ready' ? '' : phase === 'sending' ? 'Please **verify**' : 'Please **verify** the configuration.';
  const response = phase === 'responding' ? 'Everything `required`' : phase === 'complete' ? 'Everything `required` is present.' : '';
  const parameters = { to: ['team', 'worker'], message, expectResponse: true };
  return operation(
    phase === 'complete' ? { operation: 'send', parameters, result: { response } } : { operation: 'send', parameters, result: { response, phase } },
    phase === 'complete' ? 'complete' : 'active',
  );
}

describe('semantic subagent transcript rendering', () => {
  it.each(['ready', 'sending', 'waiting', 'responding', 'complete'] as const)('keeps the %s send card in its assistant slot', async (phase) => {
    const { target } = await render(send(phase));
    const operationCard = card(target, 'send');
    expect(target.querySelectorAll('[aria-label="Subagent send operation"]')).toHaveLength(1);
    expect(operationCard.textContent?.toLowerCase()).toContain(phase);
    expect(field(operationCard, 'To').textContent).toBe('team/worker');
    expectBoolean(operationCard, 'Expect response', true);
    const text = target.textContent ?? '';
    expect(text.indexOf('I will ask the worker.')).toBeLessThan(text.indexOf('Subagent send operation'));
    expect(text.indexOf('Subagent send operation')).toBeLessThan(text.indexOf('I will inspect the local file too.'));
    expect(text).toContain('read');
    if (phase !== 'ready') expect(field(operationCard, 'Message').querySelector('strong')?.textContent).toBe('verify');
    if (phase === 'responding' || phase === 'complete') expect(field(operationCard, 'Response').querySelector('code')?.textContent).toBe('required');
  });

  it('identifies a received message and renders its body as Markdown with labeled metadata', async () => {
    const incoming: SubagentContent = {
      type: 'subagent',
      operationId: 'incoming',
      subagentKind: 'message_received',
      subagentState: 'complete',
      data: { operation: 'send', result: { from: ['team', 'worker'], to: [], message: 'Please **check** the `config`.', responseExpected: true } },
    };
    const { target } = await render(incoming, true);
    const received = target.querySelector<HTMLElement>('[aria-label="Message received from team/worker"]');
    expect(received).not.toBeNull();
    expect(target.textContent).not.toContain('Subagent send operation');
    expect(received?.querySelector('[aria-label="Parameters"]')).toBeNull();
    expect(field(received!, 'Message').querySelector('strong')?.textContent).toBe('check');
    expect(field(received!, 'Message').querySelector('code')?.textContent).toBe('config');
    expect(field(received!, 'From').textContent).toBe('team/worker');
    expect(field(received!, 'To').textContent).toBe('root');
    expectBoolean(received!, 'Response expected', true);
  });

  it('omits an empty parameters section', async () => {
    const { target } = await render(operation({ operation: 'send', parameters: {}, result: { response: 'Done' } }));
    expect(card(target, 'send').querySelector('[aria-label="Parameters"]')).toBeNull();
  });

  it('renders tool parameters and results as labeled metadata and Markdown prose', async () => {
    const longDirectory = `/workspace/${'deep-directory/'.repeat(15)}config`;
    const { target } = await render(
      operation({
        operation: 'send',
        parameters: {
          to: ['team', 'worker'],
          message: 'Check **settings**.\n\n- First check\n- Second check',
          model: 'provider/model-with-**literal**-name',
          persona: 'config_*expert*',
          cwd: longDirectory,
          channels: ['parent', 'other_**worker**'],
          timeoutSeconds: 120,
          context: { note: 'See [the guide](https://example.com/guide).' },
        },
        result: {
          response: 'The settings are **valid**.',
          output: '```json\n{"enabled": true}\n```',
          error: 'One *optional* setting is missing.',
          sessionId: 'session_**literal**',
          received: false,
          attempts: 0,
          detail: { text: '> Review the optional setting.' },
        },
      }),
    );
    const operationCard = card(target, 'send');
    expect(operationCard.textContent).toContain('Parameters');
    expect(operationCard.textContent).toContain('Result');
    expect(field(operationCard, 'Message').querySelectorAll('li')).toHaveLength(2);
    expect(field(operationCard, 'Message').querySelector('strong')?.textContent).toBe('settings');
    expect(field(operationCard, 'Model').textContent).toBe('provider/model-with-**literal**-name');
    expect(field(operationCard, 'Model').querySelector('strong')).toBeNull();
    expect(field(operationCard, 'Persona').textContent).toBe('config_*expert*');
    expect(field(operationCard, 'Working directory').textContent).toBe(longDirectory);
    expect(field(operationCard, 'Channels').textContent).toContain('other_**worker**');
    expect(field(operationCard, 'Channels').querySelector('strong')).toBeNull();
    expectNumber(operationCard, 'Timeout seconds', 120);
    expect(field(operationCard, 'Note').querySelector('a')?.getAttribute('href')).toBe('https://example.com/guide');
    expect(field(operationCard, 'Response').querySelector('strong')?.textContent).toBe('valid');
    expect(field(operationCard, 'Output').querySelector('pre code')?.textContent).toContain('{"enabled": true}');
    expect(field(operationCard, 'Error').querySelector('em')?.textContent).toBe('optional');
    expect(field(operationCard, 'Session ID').textContent).toBe('session_**literal**');
    expectBoolean(operationCard, 'Received', false);
    expectNumber(operationCard, 'Attempts', 0);
    expect(field(operationCard, 'Text').querySelector('blockquote')?.textContent).toContain('Review the optional setting.');
  });

  it.each([{}, { agents: [] }])('names all-agent waits before they have statuses: %j', async (parameters) => {
    const { target } = await render(operation({ operation: 'await', parameters, result: { statuses: [] } }, 'active'));
    const operationCard = card(target, 'await');
    expect(field(operationCard, 'Agents').textContent).toBe('All agents');
    expect(field(operationCard, 'Statuses').textContent).toBe('None');
  });

  it('keeps named wait targets, interruption, outputs, errors, and session IDs visible together', async () => {
    const { target, update } = await render(
      operation({ operation: 'await', parameters: { agents: [['team', 'worker'], ['reviewer']], timeout: 30 }, result: { statuses: [] } }, 'active'),
    );
    let operationCard = card(target, 'await');
    expect(field(operationCard, 'Agents').textContent).toContain('team/worker');
    expect(field(operationCard, 'Agents').textContent).toContain('reviewer');
    await update(
      operation(
        {
          operation: 'await',
          parameters: { agents: [['team', 'worker'], ['reviewer']], timeout: 30 },
          result: {
            statuses: [{ path: ['team', 'worker'], state: 'errored', output: '**Partial report**', error: '*Worker failure*', sessionId: 'saved-worker-session' }],
            interrupted: true,
            error: '**Wait interrupted**',
          },
        },
        'aborted',
      ),
    );
    operationCard = card(target, 'await');
    expect(field(operationCard, 'Agents').textContent).toContain('reviewer');
    expect(field(operationCard, 'Path').textContent).toBe('team/worker');
    expect(field(operationCard, 'State').textContent).toBe('errored');
    expect(field(operationCard, 'Session ID').textContent).toBe('saved-worker-session');
    expectBoolean(operationCard, 'Interrupted', true);
    expect([...operationCard.querySelectorAll('strong')].map((element) => element.textContent)).toContain('Partial report');
    expect(operationCard.querySelector('em')?.textContent).toBe('Worker failure');
    expect(operationCard.textContent).toContain('Wait interrupted');
  });

  it.each([
    { operation: 'send', result: { to: [], request: '**Async request**', response: '**Async response**', error: '*Delivery warning*' } },
    { operation: 'respond', result: { body: '**Async response**', error: '*Delivery warning*' } },
    {
      operation: 'completion',
      result: {
        state: 'errored',
        output: '**Async response**',
        error: '*Delivery warning*',
        usage: { input: 101, output: 202, cacheRead: 303, cacheWrite: 404, cost: 0.125, turns: 3, costBreakdown: { input: 0.01, output: 0.1, cacheRead: 0.005, cacheWrite: 0.01 } },
      },
    },
  ] satisfies PimoteSubagentFinalData[])('renders async $operation results without fabricated parameters', async (data) => {
    const { target } = await render(operation(data), true);
    const operationCard = card(target, data.operation);
    expect(operationCard.textContent).not.toContain('Parameters');
    expect([...operationCard.querySelectorAll('strong')].map((element) => element.textContent)).toContain('Async response');
    expect(operationCard.querySelector('em')?.textContent).toBe('Delivery warning');
    if (data.operation === 'send') {
      expect(field(operationCard, 'To').textContent).toBe('root');
      expect(field(operationCard, 'Request').querySelector('strong')?.textContent).toBe('Async request');
    }
    if (data.operation === 'completion') {
      expect(field(operationCard, 'State').textContent).toBe('errored');
      const usage = field(operationCard, 'Usage');
      expectNumber(usage, 'Input', 101);
      expectNumber(usage, 'Output', 202);
      expectNumber(usage, 'Cache read', 303);
      expectNumber(usage, 'Cache write', 404);
      expectNumber(usage, 'Cost', 0.125);
      expectNumber(usage, 'Turns', 3);
      expectNumber(field(usage, 'Cost breakdown'), 'Output', 0.1);
    }
  });

  it('renders delegation inputs and every child result', async () => {
    const { target } = await render(
      operation({
        operation: 'delegation',
        parameters: { agents: [{ id: 'worker', task: 'Check **configuration**', model: 'provider/model', cwd: '/workspace', channels: ['parent'] }] },
        result: {
          children: [
            { path: ['team', 'worker'], task: 'Check **configuration**', persona: 'reviewer' },
            { path: ['tester'], task: 'Run `tests`' },
          ],
        },
      }),
    );
    const operationCard = card(target, 'delegation');
    expect(field(operationCard, 'ID').textContent).toBe('worker');
    expect(field(operationCard, 'Model').textContent).toBe('provider/model');
    const children = field(operationCard, 'Children');
    expect(children.textContent).toContain('team/worker');
    expect(children.textContent).toContain('tester');
    expect(children.querySelector('strong')?.textContent).toBe('configuration');
    expect(children.querySelector('code')?.textContent).toBe('tests');
    expect(field(children, 'Persona').textContent).toBe('reviewer');
  });

  it('distinguishes interrupted, pending, and failed targets without losing their prose', async () => {
    const { target } = await render(
      operation({
        operation: 'interrupt',
        parameters: { agents: [['team', 'worker']] },
        result: {
          interrupted: [{ path: ['team', 'worker'], output: '**Stopped output**', error: '*Stop warning*' }],
          pending: [{ path: ['slow'], output: '`Pending output`' }],
          failed: [{ path: ['gone'], error: '**Missing runtime**' }],
        },
      }),
    );
    const operationCard = card(target, 'interrupt');
    expect(field(operationCard, 'Interrupted').textContent).toContain('team/worker');
    expect(field(operationCard, 'Interrupted').querySelector('strong')?.textContent).toBe('Stopped output');
    expect(field(operationCard, 'Interrupted').querySelector('em')?.textContent).toBe('Stop warning');
    expect(field(operationCard, 'Pending').querySelector('code')?.textContent).toBe('Pending output');
    expect(field(operationCard, 'Failed').querySelector('strong')?.textContent).toBe('Missing runtime');
  });

  it.each(['teardown', 'resurrect'] as const)('renders %s parameters and saved runtime details', async (kind) => {
    const affectedAgents = [
      {
        path: ['team', 'worker'],
        sessionId: 'saved-session',
        incarnation: 'incarnation-2',
        state: 'idle' as const,
        usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.015, turns: 2 },
        output: '**Saved output**',
        error: '*Saved warning*',
      },
    ];
    const { target } = await render(
      operation(
        kind === 'teardown'
          ? { operation: kind, parameters: { agent: ['team', 'worker'] }, result: { status: 'removed', affectedAgents } }
          : {
              operation: kind,
              parameters: { agents: [{ id: 'worker', sessionId: 'saved-session', task: '**Continue review**', channels: ['parent'] }] },
              result: { affectedAgents },
            },
      ),
    );
    const operationCard = card(target, kind);
    const affected = field(operationCard, 'Affected agents');
    expect(field(affected, 'Path').textContent).toBe('team/worker');
    expect(field(affected, 'Session ID').textContent).toBe('saved-session');
    expect(field(affected, 'Incarnation').textContent).toBe('incarnation-2');
    expectNumber(affected, 'Turns', 2);
    expect(affected.querySelector('strong')?.textContent).toBe('Saved output');
    expect(field(affected, 'Error').querySelector('em')?.textContent).toBe('Saved warning');
    if (kind === 'teardown') expect(field(operationCard, 'Status').textContent).toBe('removed');
    else expect(field(operationCard, 'Task').querySelector('strong')?.textContent).toBe('Continue review');
  });

  it('renders protocol errors as Markdown', async () => {
    const { target } = await render(operation({ operation: 'protocol_error', result: { error: '**Invalid operation**: `missing result`.' } }, 'protocol_error'));
    const operationCard = card(target, 'send');
    expect(operationCard.textContent).toContain('protocol error');
    expect(field(operationCard, 'Error').querySelector('strong')?.textContent).toBe('Invalid operation');
    expect(field(operationCard, 'Error').querySelector('code')?.textContent).toBe('missing result');
  });

  it('streams send prose, then replaces it with authoritative final text and later corrections', async () => {
    const { target, update } = await render(
      operation({ operation: 'send', parameters: { to: ['worker'], message: 'Draft **request' }, result: { phase: 'sending', response: '' } }, 'active'),
    );
    let operationCard = card(target, 'send');
    expect(field(operationCard, 'Message').textContent).toContain('Draft');
    await update(
      operation({ operation: 'send', parameters: { to: ['worker'], message: 'Draft **request** grows.' }, result: { phase: 'responding', response: 'Draft *answer' } }, 'active'),
    );
    operationCard = card(target, 'send');
    expect(field(operationCard, 'Message').querySelector('strong')?.textContent).toBe('request');
    expect(field(operationCard, 'Response').textContent).toContain('Draft');
    await update(
      operation(
        { operation: 'send', parameters: { to: ['worker'], message: 'Draft **request** grows.' }, result: { phase: 'responding', response: 'Draft *answer* grows.' } },
        'active',
      ),
    );
    expect(field(card(target, 'send'), 'Response').querySelector('em')?.textContent).toBe('answer');
    await update(operation({ operation: 'send', parameters: { to: ['worker'], message: '**Final** request.' }, result: { response: '`Final` answer.' } }));
    operationCard = card(target, 'send');
    expect(field(operationCard, 'Message').textContent).toBe('Final request.');
    expect(field(operationCard, 'Message').querySelector('strong')?.textContent).toBe('Final');
    expect(field(operationCard, 'Response').textContent).toBe('Final answer.');
    expect(field(operationCard, 'Response').querySelector('code')?.textContent).toBe('Final');
    expect(operationCard.textContent).not.toContain('Draft');
    await update(operation({ operation: 'send', parameters: { to: ['worker'], message: '**Final** request.' }, result: { response: '**Corrected** answer.' } }));
    expect(field(card(target, 'send'), 'Response').textContent).toBe('Corrected answer.');
    expect(field(card(target, 'send'), 'Response').querySelector('strong')?.textContent).toBe('Corrected');
  });

  it('streams respond messages and replaces both final message and result text', async () => {
    const { target, update } = await render(operation({ operation: 'respond', parameters: { message: 'Draft **reply' }, result: {} }, 'active'));
    expect(field(card(target, 'respond'), 'Message').textContent).toContain('Draft');
    await update(operation({ operation: 'respond', parameters: { message: 'Draft **reply** grows.' }, result: {} }, 'active'));
    expect(field(card(target, 'respond'), 'Message').querySelector('strong')?.textContent).toBe('reply');
    await update(operation({ operation: 'respond', parameters: { message: '*Final reply*' }, result: { message: '**Delivered**', error: '*Delivery warning*' } }));
    const operationCard = card(target, 'respond');
    expect(field(operationCard, 'Message').textContent).toBe('Final reply');
    expect(field(operationCard, 'Message').querySelector('em')?.textContent).toBe('Final reply');
    expect(operationCard.textContent).toContain('Delivered');
    expect(field(operationCard, 'Error').querySelector('em')?.textContent).toBe('Delivery warning');
    expect(operationCard.textContent).not.toContain('Draft');
  });
});
