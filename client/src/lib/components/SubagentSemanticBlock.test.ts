// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { reduceSubagentWireSemanticEvents } from '$lib/subagent-semantic.js';
import SubagentSemanticBlock from './SubagentSemanticBlock.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

async function render(responseExpected: boolean, phase: 'sent' | 'received' = 'sent') {
  const block = reduceSubagentWireSemanticEvents([
    {
      type: 'subagent_event',
      sessionId: 'root',
      eventId: 'message',
      cursor: 1,
      path: [],
      relatedPiEvents: [],
      kind: 'message_thread',
      data: { phase, from: phase === 'sent' ? [] : ['worker'], to: phase === 'sent' ? ['worker'] : [], text: 'Check the callback.', responseExpected },
    },
  ]).blocks[0];
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(SubagentSemanticBlock, { target, props: { block } });
  await tick();
  return target;
}

describe('subagent message presentation', () => {
  it.each([true, false])('shows the recipient and an icon for reply expectation=%s', async (expected) => {
    const target = await render(expected);
    const header = target.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(header.textContent).toContain('worker');
    const cue = header.querySelector(`[aria-label="${expected ? 'Response expected' : 'No response expected'}"]`);
    expect(cue).not.toBeNull();
    expect(cue?.textContent?.trim()).toBe('');
    expect(target.textContent).not.toContain('Request');
    expect(target.textContent).not.toContain('root');
    expect(target.textContent?.match(/worker/g)).toHaveLength(1);
    expect(target.textContent).toContain('Check the callback.');
  });

  it.each([
    { viewerPath: [], peer: 'worker' },
    { viewerPath: ['worker'], peer: 'root' },
  ])('shows the reply counterparty for viewer=$viewerPath', async ({ viewerPath, peer }) => {
    const block = reduceSubagentWireSemanticEvents([
      {
        type: 'subagent_event',
        sessionId: 'root',
        eventId: 'reply',
        cursor: 1,
        path: ['worker'],
        relatedPiEvents: [],
        kind: 'message_thread',
        data: { phase: 'response', from: ['worker'], to: [], text: 'Review complete.', responseExpected: false },
      },
    ]).blocks[0];
    const target = document.createElement('div');
    component = mount(SubagentSemanticBlock, { target, props: { block, viewerPath } });
    await tick();
    expect(target.querySelector('button[aria-expanded]')?.textContent).toContain(peer);
    expect(target.textContent).toContain('Review complete.');
  });

  it('keeps a failed communication failed even when its error text is empty', async () => {
    const block = reduceSubagentWireSemanticEvents([
      {
        type: 'subagent_event',
        sessionId: 'root',
        eventId: 'failure',
        cursor: 1,
        path: [],
        relatedPiEvents: [],
        kind: 'message_thread',
        data: { phase: 'failure', from: [], to: ['worker'], text: 'Check the callback.', responseExpected: true, error: '' },
      },
    ]).blocks[0];
    const target = document.createElement('div');
    component = mount(SubagentSemanticBlock, { target, props: { block } });
    await tick();
    expect(target.querySelector('article')?.getAttribute('aria-label')).toBe('Message failed');
    expect(target.querySelector('article')?.getAttribute('data-semantic-status')).toBe('error');
  });

  it('renders a successful wait as completed without an error indication', async () => {
    const block = reduceSubagentWireSemanticEvents([
      {
        type: 'subagent_event',
        sessionId: 'root',
        eventId: 'completed',
        cursor: 1,
        path: [],
        relatedPiEvents: [],
        kind: 'await_released',
        data: { invocationId: 'wait', statuses: [{ path: ['worker'], state: 'idle', output: 'Review complete.', error: '' }] },
      },
    ]).blocks[0];
    const target = document.createElement('div');
    component = mount(SubagentSemanticBlock, { target, props: { block } });
    await tick();
    expect(target.querySelector('article')?.getAttribute('aria-label')).toBe('Await completed');
    expect(target.querySelector('article')?.getAttribute('data-semantic-status')).toBe('success');
    expect(target.querySelector('.lucide-circle-alert')).toBeNull();
    expect(target.textContent).toContain('Review complete.');
    expect(target.textContent).not.toContain('Error:');
  });

  it('identifies the sender of an inbound message in the same compact header', async () => {
    const target = await render(false, 'received');
    const header = target.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(header.textContent).toContain('Message received');
    expect(header.textContent).toContain('worker');
    expect(target.textContent).not.toContain('Request');
    expect(target.textContent).toContain('Check the callback.');
  });
});
