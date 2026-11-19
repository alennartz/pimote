import type { PerSessionState } from '$lib/stores/session-registry.svelte.js';

type SessionPillState = Pick<PerSessionState, 'status' | 'needsAttention'>;

/** Choose the folder glyph color for an active-session chip.
 *
 * Pending UI and settled attention use the warning role. Working uses the
 * streaming role and outranks a stale attention flag, matching the pulse.
 */
export function getSessionPillIconColor(session: SessionPillState, hasPendingUi: boolean): string {
  if (hasPendingUi) return 'text-status-reconnecting';
  if (session.status === 'working') return 'text-status-streaming';
  if (session.needsAttention) return 'text-status-reconnecting';
  return '';
}
