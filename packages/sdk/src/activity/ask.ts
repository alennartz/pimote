import type { EventBus } from '@earendil-works/pi-coding-agent';

/**
 * Poll a session's extensions for background activity (DR-054).
 *
 * Synchronous round-trip, mirroring `panels/detect`: responders run inline
 * during `emit`, so their answers are captured before this returns. Call only
 * for sessions already past the idle-reap threshold — the poll is invisible
 * until it matters.
 *
 * Fails open: no responder, or any responder answering `active: false`, means
 * no background work and the caller may reap. When several extensions answer,
 * responses are OR-ed — any assertion of live work holds the session.
 */
export function askActivity(bus: EventBus): boolean {
  let active = false;
  const unsubscribe = bus.on('pimote:activity:response', (data) => {
    const message = data as { active?: unknown } | null | undefined;
    if (message?.active === true) active = true;
  });
  bus.emit('pimote:activity:request', {});
  unsubscribe();
  return active;
}
