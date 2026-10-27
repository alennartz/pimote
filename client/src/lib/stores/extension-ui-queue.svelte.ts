import { connection } from '$lib/stores/connection.svelte.js';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import type { ExtensionUiRequestEvent } from '@pimote/shared';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

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

type ResponseData = { value?: string; confirmed?: boolean; cancelled?: boolean };

const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify', 'setEditorText', 'setTitle']);

/** Methods rendered inline (not as a modal) */
export const INLINE_METHODS = new SvelteSet(['select', 'confirm']);

let queue = $state<DialogRequest[]>([]);
const editorDrafts = $state<Record<string, string>>({});
let _initialized = false;

/** Draft keys include the session because request IDs are only session-scoped. */
function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function hasEditorDraft(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(editorDrafts, key);
}

const pendingResponses = new SvelteMap<string, ResponseAttempt>();

interface ResponseAttempt {
  key: string;
  sessionId: string;
  requestId: string;
  entry?: DialogRequest;
}

function invalidateSessionResponses(sessionId: string): void {
  for (const [key, attempt] of pendingResponses) {
    if (attempt.sessionId === sessionId) pendingResponses.delete(key);
  }
}

function invalidateResponse(key: string): void {
  pendingResponses.delete(key);
}

function responseIsCurrent(attempt: ResponseAttempt): boolean {
  return pendingResponses.get(attempt.key) === attempt;
}

function removeEditorDraft(sessionId: string, requestId: string): void {
  const key = requestKey(sessionId, requestId);
  if (hasEditorDraft(key)) delete editorDrafts[key];
}

function removeSessionEditorDrafts(sessionId: string, replayed: Set<string>): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of Object.keys(editorDrafts)) {
    if (key.startsWith(prefix) && !replayed.has(key)) delete editorDrafts[key];
  }
}

interface RestoreState {
  /** Requests delivered after the most recent restore started event. */
  replayed: Set<string>;
}

const restores = new SvelteMap<string, RestoreState>();

function ensureListener() {
  if (_initialized) return;
  _initialized = true;

  connection.onEvent((event) => {
    // Drop queued dialogs for a session that has closed — no one can answer
    // them anymore, and a stale entry would keep hasRequestForSession() true.
    if (event.type === 'session_closed') {
      queue = queue.filter((r) => r.sessionId !== event.sessionId);
      for (const key of Object.keys(editorDrafts)) {
        if (key.startsWith(`${event.sessionId}\u0000`)) delete editorDrafts[key];
      }
      restores.delete(event.sessionId);
      invalidateSessionResponses(event.sessionId);
      return;
    }
    if (event.type === 'extension_ui_resolved') {
      queue = queue.filter((r) => !(r.sessionId === event.sessionId && r.requestId === event.requestId));
      removeEditorDraft(event.sessionId, event.requestId);
      invalidateResponse(requestKey(event.sessionId, event.requestId));
      return;
    }
    // A restore re-sends every dialog still pending on the server. Drop the
    // local copies first: another observer may have answered one while this
    // client was offline, and extension_ui_resolved is not replayed. Drafts
    // stay in the separate buffer until the restore completes.
    if (event.type === 'session_restore') {
      if (event.status === 'started') {
        queue = queue.filter((r) => r.sessionId !== event.sessionId);
        invalidateSessionResponses(event.sessionId);
        // A second start replaces the replay set, but never drops drafts. This
        // keeps an interrupted restore safe until its eventual completion.
        restores.set(event.sessionId, { replayed: new Set() });
        return;
      }
      const restore = restores.get(event.sessionId);
      if (restore) {
        removeSessionEditorDrafts(event.sessionId, restore.replayed);
        // A response attempt for a request that was replayed remains valid. An
        // attempt for a stale request must not re-add it after completion.
        for (const [key, attempt] of pendingResponses) {
          if (attempt.sessionId === event.sessionId && !restore.replayed.has(key)) pendingResponses.delete(key);
        }
        restores.delete(event.sessionId);
      }
      return;
    }
    if (event.type !== 'extension_ui_request') return;
    const req = event as ExtensionUiRequestEvent;
    if (FIRE_AND_FORGET.has(req.method)) return;
    const key = requestKey(req.sessionId, req.requestId);
    const restore = restores.get(req.sessionId);
    if (restore) restore.replayed.add(key);
    if (queue.some((r) => r.sessionId === req.sessionId && r.requestId === req.requestId)) return;
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
    /** Return an editor draft, or its original prefill when no draft exists. */
    getEditorValue(request: DialogRequest): string {
      const key = requestKey(request.sessionId, request.requestId);
      return hasEditorDraft(key) ? editorDrafts[key] : (request.prefill ?? '');
    },
    /** Store only an editor value that differs from the original prefill. */
    setEditorValue(request: DialogRequest, value: string): void {
      if (request.method !== 'editor') return;
      const key = requestKey(request.sessionId, request.requestId);
      if (value === (request.prefill ?? '')) {
        if (hasEditorDraft(key)) delete editorDrafts[key];
      } else {
        // Keep the own property even for an empty string. Empty text is a real
        // draft when the original prefill was non-empty.
        editorDrafts[key] = value;
      }
    },
    sendResponse(requestId: string, sessionId: string, data: ResponseData): void {
      const key = requestKey(sessionId, requestId);
      const entry = queue.find((r) => r.requestId === requestId && r.sessionId === sessionId);
      // Optimistically remove so the dialog closes immediately…
      queue = queue.filter((r) => !(r.requestId === requestId && r.sessionId === sessionId));
      const attempt: ResponseAttempt = { key, sessionId, requestId, entry };
      pendingResponses.set(key, attempt);
      connection
        .send({
          type: 'extension_ui_response',
          sessionId,
          requestId,
          ...data,
        })
        .then(
          () => {
            // Only the live attempt may settle its editor draft. A stale
            // response can arrive after a restore replay and newer edits.
            if (!responseIsCurrent(attempt)) return;
            pendingResponses.delete(key);
            removeEditorDraft(sessionId, requestId);
          },
          (err) => {
            // …but if the send fails (e.g. WS down), re-queue the entry so the
            // user keeps an affordance to answer once reconnected, and don't
            // leak an unhandled rejection. An intervening resolution, session
            // close, or restore lifecycle event invalidates this attempt.
            console.warn('[extension-ui] failed to send response; re-queuing', err);
            if (!responseIsCurrent(attempt)) return;
            pendingResponses.delete(key);
            if (entry && !queue.some((r) => r.sessionId === sessionId && r.requestId === requestId)) {
              queue = [...queue, entry];
            }
          },
        );
    },
  };
}
