import { describe, expect, it, vi } from 'vitest';
import type { PimoteEvent } from '@pimote/shared';

const listeners = vi.hoisted(() => new Set<(event: PimoteEvent) => void>());
const transport = vi.hoisted(() => ({ send: vi.fn(async () => ({ success: true })) }));
vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: {
    onEvent: (listener: (event: PimoteEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: transport.send,
  },
}));
vi.mock('$lib/stores/session-registry.svelte.js', () => ({ sessionRegistry: { viewedSessionId: 's1' } }));
import { getExtensionUiQueue } from './extension-ui-queue.svelte.js';

function emit(event: PimoteEvent) {
  for (const listener of listeners) listener(event);
}

describe('extension dialog resolution', () => {
  it('closes only the matching session and request when another observer answers', () => {
    const queue = getExtensionUiQueue();
    emit({ type: 'extension_ui_request', sessionId: 's1', requestId: 'same', method: 'confirm', title: 'Continue?' });
    emit({ type: 'extension_ui_request', sessionId: 's2', requestId: 'same', method: 'confirm', title: 'Continue?' });
    emit({ type: 'extension_ui_request', sessionId: 's1', requestId: 'other', method: 'input', title: 'Name?' });
    emit({ type: 'extension_ui_resolved', sessionId: 's1', requestId: 'same' });
    expect(queue.all.map(({ sessionId, requestId }) => [sessionId, requestId])).toEqual([
      ['s2', 'same'],
      ['s1', 'other'],
    ]);
    emit({ type: 'extension_ui_resolved', sessionId: 's1', requestId: 'missing' });
    expect(queue.all).toHaveLength(2);
  });

  it('drops a session\u2019s dialogs when a restore starts and keeps the ones the server re-sends, once', () => {
    const queue = getExtensionUiQueue();
    // Answered elsewhere while this client was offline: never re-sent.
    emit({ type: 'extension_ui_request', sessionId: 'r1', requestId: 'stale', method: 'confirm', title: 'Old?' });
    emit({ type: 'extension_ui_request', sessionId: 'r1', requestId: 'live', method: 'confirm', title: 'Still?' });
    emit({ type: 'extension_ui_request', sessionId: 'r2', requestId: 'untouched', method: 'confirm', title: 'Other?' });

    emit({ type: 'session_restore', sessionId: 'r1', mode: 'incremental_replay', status: 'started' });
    emit({ type: 'extension_ui_request', sessionId: 'r1', requestId: 'live', method: 'confirm', title: 'Still?' });
    emit({ type: 'extension_ui_request', sessionId: 'r1', requestId: 'live', method: 'confirm', title: 'Still?' });

    const ids = queue.all.filter((r) => r.sessionId === 'r1' || r.sessionId === 'r2').map(({ sessionId, requestId }) => [sessionId, requestId]);
    expect(ids).toEqual([
      ['r2', 'untouched'],
      ['r1', 'live'],
    ]);
  });

  it('keeps editor drafts separate from visible requests and from other sessions', () => {
    const queue = getExtensionUiQueue();
    const first = { sessionId: 'draft-a', requestId: 'same-id', method: 'editor', prefill: 'first' };
    const second = { sessionId: 'draft-b', requestId: 'same-id', method: 'editor', prefill: 'second' };
    emit({ type: 'extension_ui_request', ...first });
    emit({ type: 'extension_ui_request', ...second });
    const firstEntry = queue.all.find((entry) => entry.sessionId === first.sessionId && entry.requestId === first.requestId);
    const secondEntry = queue.all.find((entry) => entry.sessionId === second.sessionId && entry.requestId === second.requestId);
    if (!firstEntry || !secondEntry) throw new Error('editor requests not queued');

    queue.setEditorValue(firstEntry, 'edited first');
    queue.setEditorValue(secondEntry, 'edited second');
    expect(queue.getEditorValue(firstEntry)).toBe('edited first');
    expect(queue.getEditorValue(secondEntry)).toBe('edited second');

    emit({ type: 'extension_ui_resolved', sessionId: first.sessionId, requestId: first.requestId });
    expect(queue.getEditorValue(firstEntry)).toBe('first');
    expect(queue.getEditorValue(secondEntry)).toBe('edited second');
  });

  it('preserves an empty editor draft and drops a clean draft', () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'draft-empty', requestId: 'editor', method: 'editor', prefill: 'seed' };
    emit({ type: 'extension_ui_request', ...request });
    const entry = queue.all.find((candidate) => candidate.sessionId === request.sessionId && candidate.requestId === request.requestId);
    if (!entry) throw new Error('editor request not queued');

    queue.setEditorValue(entry, '');
    expect(queue.getEditorValue(entry)).toBe('');
    queue.setEditorValue(entry, request.prefill);
    expect(queue.getEditorValue(entry)).toBe(request.prefill);
  });

  it('prunes stale drafts only after restore completion', () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'draft-stale', requestId: 'editor', method: 'editor', prefill: 'seed' };
    emit({ type: 'extension_ui_request', ...request });
    const entry = queue.all.find((candidate) => candidate.sessionId === request.sessionId && candidate.requestId === request.requestId);
    if (!entry) throw new Error('editor request not queued');
    queue.setEditorValue(entry, 'edited');

    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'started' });
    expect(queue.getEditorValue(entry)).toBe('edited');
    expect(queue.hasRequestForSession(request.sessionId)).toBe(false);
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'completed' });
    expect(queue.getEditorValue(entry)).toBe(request.prefill);
  });

  it('retains drafts through repeated interrupted restores and keeps replayed requests', () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'draft-repeated', requestId: 'editor', method: 'editor', prefill: 'seed' };
    emit({ type: 'extension_ui_request', ...request });
    const entry = queue.all.find((candidate) => candidate.sessionId === request.sessionId && candidate.requestId === request.requestId);
    if (!entry) throw new Error('editor request not queued');
    queue.setEditorValue(entry, 'edited');

    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'started' });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'started' });
    expect(queue.getEditorValue(entry)).toBe('edited');
    emit({ type: 'extension_ui_request', ...request });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'completed' });
    expect(queue.getEditorValue(entry)).toBe('edited');
  });

  it('does not requeue a response after an intervening resolution', async () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'response-stale', requestId: 'editor', method: 'editor', prefill: 'seed' };
    emit({ type: 'extension_ui_request', ...request });
    const entry = queue.all.find((candidate) => candidate.sessionId === request.sessionId && candidate.requestId === request.requestId);
    if (!entry) throw new Error('editor request not queued');
    queue.setEditorValue(entry, 'edited');

    let rejectSend!: (reason: unknown) => void;
    transport.send.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectSend = reject)));
    queue.sendResponse(request.requestId, request.sessionId, { value: 'edited' });
    emit({ type: 'extension_ui_resolved', sessionId: request.sessionId, requestId: request.requestId });
    rejectSend(new Error('offline'));
    await Promise.resolve();
    expect(queue.hasRequestForSession(request.sessionId)).toBe(false);
    expect(queue.getEditorValue(entry)).toBe(request.prefill);
  });

  it('does not requeue a response after restore completion', async () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'response-restore', requestId: 'editor', method: 'editor', prefill: 'seed' };
    emit({ type: 'extension_ui_request', ...request });
    const entry = queue.all.find((candidate) => candidate.sessionId === request.sessionId && candidate.requestId === request.requestId);
    if (!entry) throw new Error('editor request not queued');

    let rejectSend!: (reason: unknown) => void;
    transport.send.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectSend = reject)));
    queue.sendResponse(request.requestId, request.sessionId, { value: 'edited' });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'started' });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'completed' });
    rejectSend(new Error('offline'));
    await Promise.resolve();
    expect(queue.hasRequestForSession(request.sessionId)).toBe(false);
  });

  it('requeues a replayed input when its response fails after restore completion', async () => {
    const queue = getExtensionUiQueue();
    const request = { sessionId: 'response-input', requestId: 'input', method: 'input', title: 'Name?' };
    emit({ type: 'extension_ui_request', ...request });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'started' });
    emit({ type: 'extension_ui_request', ...request });

    let rejectSend!: (reason: unknown) => void;
    transport.send.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectSend = reject)));
    queue.sendResponse(request.requestId, request.sessionId, { value: 'Ada' });
    emit({ type: 'session_restore', sessionId: request.sessionId, mode: 'incremental_replay', status: 'completed' });
    rejectSend(new Error('offline'));
    await Promise.resolve();
    expect(queue.hasRequestForSession(request.sessionId)).toBe(true);
  });
});
