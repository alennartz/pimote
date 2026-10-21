import { describe, expect, it, vi } from 'vitest';
import type { PimoteEvent } from '@pimote/shared';

const listeners = vi.hoisted(() => new Set<(event: PimoteEvent) => void>());
vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: {
    onEvent: (listener: (event: PimoteEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: vi.fn(async () => ({ success: true })),
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
});
