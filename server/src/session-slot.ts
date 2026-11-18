import type { PimoteEvent, PimoteSessionEvent } from '../../shared/dist/index.js';
import type { EventSocket, ManagedSlot, SessionObserver } from './session-manager.js';

const LIVE_BATCH_DELAY_MS = 16;
const MAX_LIVE_BATCH_EVENTS = 128;

interface QueuedObserverEvent {
  slot?: ManagedSlot;
  observer?: SessionObserver;
  event: PimoteEvent;
}

interface LiveEventBatch {
  timer: ReturnType<typeof setTimeout>;
  entries: QueuedObserverEvent[];
}

const pendingBatches = new WeakMap<EventSocket, LiveEventBatch>();

function isStreamingSessionEvent(event: PimoteEvent): event is PimoteSessionEvent {
  return event.type === 'message_update' || event.type === 'tool_execution_update' || event.type === 'bash_execution_update' || event.type === 'subagent_content_delta';
}

function isStreamingEvent(event: PimoteEvent): boolean {
  if (isStreamingSessionEvent(event)) return true;
  if (event.type === 'subagent_view_event') return isStreamingSessionEvent(event.event);
  return false;
}

function flushLiveBatch(socket: EventSocket): void {
  const batch = pendingBatches.get(socket);
  if (!batch) return;
  clearTimeout(batch.timer);
  pendingBatches.delete(socket);
  if (socket.readyState !== 1) return;

  // An observer can detach during the 16ms window. Do not send its queued
  // transcript deltas after the detach has taken effect.
  const entries = batch.entries.filter(({ slot, observer }) => !slot || !observer || slot.observers.get(observer.clientId) === observer);
  if (entries.length === 0) return;

  const events = entries.map(({ event }) => event);
  try {
    socket.send(JSON.stringify({ type: 'event_batch', events }));
    for (const { observer, event } of entries) {
      if (observer && 'cursor' in event && typeof event.cursor === 'number') observer.cursor = Math.max(observer.cursor, event.cursor);
    }
  } catch {
    // WebSocket send failed — leave cursors behind so reconnect replays.
  }
}

function queueLiveEvent(slot: ManagedSlot, observer: SessionObserver, event: PimoteSessionEvent): void {
  queueLiveEventEntry(observer.ws, { slot, observer, event });
}

/** Batch one event for an observer socket, including an owned child view. */
export function sendBatchedEvent(socket: EventSocket, event: PimoteEvent): boolean {
  if (socket.readyState !== 1) return false;
  if (isStreamingEvent(event)) {
    queueLiveEventEntry(socket, { event });
    return true;
  }
  flushLiveBatch(socket);
  try {
    socket.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

function queueLiveEventEntry(socket: EventSocket, entry: QueuedObserverEvent): void {
  let batch = pendingBatches.get(socket);
  if (!batch) {
    batch = { entries: [], timer: setTimeout(() => flushLiveBatch(socket), LIVE_BATCH_DELAY_MS) };
    pendingBatches.set(socket, batch);
  }
  batch.entries.push(entry);
  if (batch.entries.length >= MAX_LIVE_BATCH_EVENTS) flushLiveBatch(socket);
}

/** Send one session event to every live observer. */
export function sendSlotEvent(slot: ManagedSlot, event: PimoteEvent, options?: { exceptClientId?: string }): void {
  if (isStreamingEvent(event)) {
    for (const observer of slot.observers.values()) {
      if (observer.clientId === options?.exceptClientId || observer.ws.readyState !== 1) continue;
      if (isStreamingSessionEvent(event)) queueLiveEvent(slot, observer, event);
      else queueLiveEventEntry(observer.ws, { slot, observer, event });
    }
    return;
  }

  const observers = [...slot.observers.values()].filter((observer) => observer.clientId !== options?.exceptClientId && observer.ws.readyState === 1);
  // A non-streaming lifecycle boundary must follow queued deltas immediately.
  // Serialize this event once, then share the wire string across all observers.
  const serialized = JSON.stringify(event);
  for (const observer of observers) {
    flushLiveBatch(observer.ws);
    try {
      observer.ws.send(serialized);
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
  for (const [, pending] of slot.sessionState.pendingUiResponses) pending.resolve(undefined);
  slot.sessionState.pendingUiResponses.clear();
  for (const requestId of requestIds) {
    sendSlotEvent(slot, { type: 'extension_ui_resolved', sessionId: slot.sessionState.id, requestId });
  }
}

/** Re-send all pending UI request events to the current client. Called on reconnect to recover lost dialogs. */
export function replaySlotPendingUiRequests(slot: ManagedSlot, send: (event: PimoteEvent) => void): void {
  for (const [, pending] of slot.sessionState.pendingUiResponses) send(pending.event);
}
