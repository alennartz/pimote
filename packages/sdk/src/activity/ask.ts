import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { ActivityMessage } from './types.js';

/** Response payloads arrive unvalidated over the bus; only an explicit `active: true` counts. */
function isActiveResponse(data: unknown): data is Partial<ActivityMessage> {
  return typeof data === 'object' && data !== null;
}

/**
 * Poll a session's extensions for background activity (DR-054).
 *
 * Synchronous round-trip, mirroring `panels/detect`: responders run inline
 * during `emit`, so their answers are captured before this returns. Call only
 * for sessions already past the idle-reap threshold — the poll is invisible
 * until it matters.
 *
 * Fails open: no responder, or no responder answering `active: true`, means
 * no background work and the caller may reap. When several extensions answer,
 * responses are OR-ed — any assertion of live work holds the session.
 */
export function askActivity(bus: EventBus): boolean {
  let active = false;
  const unsubscribe = bus.on('pimote:activity:response', (data) => {
    if (isActiveResponse(data) && data.active === true) {
      active = true;
    }
  });
  bus.emit('pimote:activity:request', {});
  unsubscribe();
  return active;
}
