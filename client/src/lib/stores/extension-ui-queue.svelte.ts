import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import type { ExtensionUiRequestEvent } from '@pimote/shared';
import { SvelteSet } from 'svelte/reactivity';

/**
 * Shared reactive queue for extension UI requests.
 * Both the inline select panel and the modal dialog consume from this.
 */

export interface DialogRequest {
  requestId: string;
  sessionId: string;
  method: string;
  title?: string;
  message?: string;
  options?: { label: string; value: string }[];
  placeholder?: string;
  prefill?: string;
  content?: string;
  [key: string]: unknown;
}

const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify', 'setEditorText', 'setTitle']);

/** Methods rendered inline (not as a modal) */
export const INLINE_METHODS = new SvelteSet(['select', 'confirm']);

let queue = $state<DialogRequest[]>([]);
let _initialized = false;

function ensureListener() {
  if (_initialized) return;
  _initialized = true;

  connection.onEvent((event) => {
    // Drop queued dialogs for a session that has closed — no one can answer
    // them anymore, and a stale entry would keep hasRequestForSession() true.
    if (event.type === 'session_closed') {
      queue = queue.filter((r) => r.sessionId !== event.sessionId);
      return;
    }
    if (event.type !== 'extension_ui_request') return;
    const req = event as ExtensionUiRequestEvent;
    if (FIRE_AND_FORGET.has(req.method)) return;
    queue = [...queue, req as unknown as DialogRequest];
  });
}

export function getExtensionUiQueue() {
  ensureListener();
  return {
    get all() {
      return queue;
    },
    get inlineCurrent(): DialogRequest | null {
      const viewedId = sessionRegistry.viewedSessionId;
      return queue.find((r) => INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
    },
    get modalCurrent(): DialogRequest | null {
      const viewedId = sessionRegistry.viewedSessionId;
      return queue.find((r) => !INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
    },
    hasRequestForSession(sessionId: string): boolean {
      return queue.some((r) => r.sessionId === sessionId);
    },
    sendResponse(requestId: string, sessionId: string, data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
      const entry = queue.find((r) => r.requestId === requestId);
      // Optimistically remove so the dialog closes immediately…
      queue = queue.filter((r) => r.requestId !== requestId);
      connection
        .send({
          type: 'extension_ui_response',
          sessionId,
          requestId,
          ...data,
        })
        .catch((err) => {
          // …but if the send fails (e.g. WS down), re-queue the entry so the
          // user keeps an affordance to answer once reconnected, and don't
          // leak an unhandled rejection.
          console.warn('[extension-ui] failed to send response; re-queuing', err);
          if (entry && !queue.some((r) => r.requestId === requestId)) {
            queue = [...queue, entry];
          }
        });
    },
  };
}
