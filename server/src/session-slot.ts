import type { PimoteEvent } from '../../shared/dist/index.js';
import type { ManagedSlot } from './session-manager.js';

/** Send one session event to every live observer. */
export function sendSlotEvent(slot: ManagedSlot, event: PimoteEvent, options?: { exceptClientId?: string }): void {
  for (const observer of slot.observers.values()) {
    if (observer.clientId === options?.exceptClientId) continue;
    if (!observer.ws || observer.ws.readyState !== 1) continue;
    try {
      observer.ws.send(JSON.stringify(event));
      if ('cursor' in event && typeof event.cursor === 'number') observer.cursor = event.cursor;
    } catch {
      // WebSocket send failed — ignore (client disconnecting)
    }
  }
}

/** Create a pending promise for a UI dialog response. Stores the request event for replay on reconnect. */
export function waitForSlotUiResponse(slot: ManagedSlot, requestId: string, requestEvent: PimoteEvent): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    slot.sessionState.pendingUiResponses.set(requestId, { resolve, event: requestEvent });
  });
}

/** Resolve a specific pending UI response by requestId. */
export function resolveSlotPendingUi(slot: ManagedSlot, requestId: string, value: unknown): boolean {
  const pending = slot.sessionState.pendingUiResponses.get(requestId);
  if (!pending) return false;
  slot.sessionState.pendingUiResponses.delete(requestId);
  pending.resolve(value);
  return true;
}

/** Resolve all pending UI responses with undefined. Used on abort, session close, or session reset. */
export function resolveAllSlotPendingUi(slot: ManagedSlot): void {
  const requestIds = [...slot.sessionState.pendingUiResponses.keys()];
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    pending.resolve(undefined);
  }
  slot.sessionState.pendingUiResponses.clear();
  for (const requestId of requestIds) {
    sendSlotEvent(slot, { type: 'extension_ui_resolved', sessionId: slot.sessionState.id, requestId });
  }
}

/** Re-send all pending UI request events to the current client. Called on reconnect to recover lost dialogs. */
export function replaySlotPendingUiRequests(slot: ManagedSlot, send: (event: PimoteEvent) => void): void {
  for (const [, pending] of slot.sessionState.pendingUiResponses) {
    send(pending.event);
  }
}
