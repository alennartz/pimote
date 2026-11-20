import type { ExtensionUiRequestEvent, PimoteEvent } from '@pimote/shared';
import { connection } from '$lib/stores/connection.svelte.js';
import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
import { ExtensionEditorWorkspaceHost, type EditorRequest, type EditorWorkspaceKey, type EditorWireAnswer } from '$lib/extension-editor-workspace.js';

let singleton: ExtensionEditorWorkspaceHost | null = null;

function editorRequest(event: ExtensionUiRequestEvent): EditorRequest {
  return {
    key: { sessionId: event.sessionId, requestId: event.requestId },
    ...(typeof event.title === 'string' ? { title: event.title } : {}),
    ...(typeof event.message === 'string' ? { message: event.message } : {}),
    ...(typeof event.prefill === 'string' ? { prefill: event.prefill } : {}),
  };
}

function sameKey(left: EditorWorkspaceKey, right: EditorWorkspaceKey): boolean {
  return left.sessionId === right.sessionId && left.requestId === right.requestId;
}

function createHost(): ExtensionEditorWorkspaceHost {
  const uiQueue = getExtensionUiQueue();
  const host = new ExtensionEditorWorkspaceHost({
    sendResponse: (key: EditorWorkspaceKey, answer: EditorWireAnswer) => uiQueue.sendResponse(key.requestId, key.sessionId, answer),
    isModalOwner: (key) => {
      const current = uiQueue.modalCurrent;
      return current !== null && sameKey(current, key);
    },
  });

  connection.onEvent((event: PimoteEvent) => {
    if (event.type === 'extension_ui_request') {
      if (event.method === 'editor') host.ingestRequest(editorRequest(event as ExtensionUiRequestEvent));
      host.refresh();
      return;
    }
    if (event.type === 'extension_ui_resolved') {
      host.resolved({ sessionId: event.sessionId, requestId: event.requestId });
      return;
    }
    if (event.type === 'session_restore') {
      if (event.status === 'started') host.restoreStarted(event.sessionId);
      else host.restoreCompleted(event.sessionId);
      return;
    }
    if (event.type === 'session_closed') {
      host.sessionClosed(event.sessionId);
      return;
    }
    if (event.type === 'session_replaced') {
      host.sessionReplaced(event.oldSessionId, event.newSessionId);
    }
  });

  // These callbacks cover local restore failures and profile-driven removal,
  // which do not always produce a session_closed wire event.
  connection.onSessionRestoreComplete?.((sessionId) => host.restoreBarrier(sessionId));
  connection.onSessionUnavailable?.((sessionId) => host.sessionClosed(sessionId));

  return host;
}

/** The route-independent editor workspace host. */
export function getExtensionEditorHost(): ExtensionEditorWorkspaceHost {
  return (singleton ??= createHost());
}
