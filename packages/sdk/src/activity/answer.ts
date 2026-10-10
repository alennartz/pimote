import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ActivityMessage } from './types.js';

/**
 * Answer pimote's background-activity polls for this session.
 *
 * Pimote's idle reaper calls this poll (DR-054) before closing an idle session
 * with no connected client. Return true when closing the session now would
 * destroy live work (for example: background subagents still running).
 *
 * The poll is a synchronous EventBus round-trip, mirroring `panels/detect`:
 * pimote emits `pimote:activity:request` and reads the response inline. The
 * `isActive` callback must therefore be synchronous — an async answer is
 * indistinguishable from no answer. Answering is extension policy: pimote
 * learns only the boolean, never what the work is.
 *
 * If `isActive` throws, the responder answers `active: true`: a broken
 * predicate must park the session (recoverable by explicit close), not destroy
 * work. Register once per session; the returned unsubscribe is for symmetry
 * and tests — the bus dies with the session.
 */
export function answerActivity(pi: ExtensionAPI, isActive: () => boolean): () => void {
  return pi.events.on('pimote:activity:request', () => {
    let active: boolean;
    try {
      active = isActive();
    } catch (error) {
      console.error('[pimote:activity] responder threw; answering active to protect live work', error);
      active = true;
    }
    pi.events.emit('pimote:activity:response', { active } satisfies ActivityMessage);
  });
}
