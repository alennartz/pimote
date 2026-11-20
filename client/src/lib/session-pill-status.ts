import type { PerSessionState } from '$lib/stores/session-registry.svelte.js';

type SessionPillState = Pick<PerSessionState, 'status' | 'needsAttention'>;

/** Choose the folder glyph role for a session chip.
 *
 * Selected chips use status roles paired with the primary surface. Pending UI
 * and settled attention use the warning role. Working outranks stale attention.
 */
export function getSessionPillIconColor(session: SessionPillState, hasPendingUi: boolean, isViewed: boolean): string {
  if (hasPendingUi) return isViewed ? 'text-status-reconnecting-on-primary' : 'text-status-reconnecting';
  if (session.status === 'working') return isViewed ? 'text-status-streaming-on-primary' : 'text-status-streaming';
  if (session.needsAttention) return isViewed ? 'text-status-reconnecting-on-primary' : 'text-status-reconnecting';
  return '';
}
