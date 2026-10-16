import type { PerSessionState } from '$lib/stores/session-registry.svelte.js';

type SessionPillState = Pick<PerSessionState, 'status' | 'needsAttention'>;

/** Choose the folder glyph color for an active-session chip.
 *
 * Pending UI takes priority over the working pulse. Working takes priority
 * over a stale completion-attention flag, so the glyph matches the pulse.
 */
export function getSessionPillIconColor(session: SessionPillState, hasPendingUi: boolean): string {
  if (hasPendingUi) return 'text-orange-500';
  if (session.status === 'working') return 'text-emerald-500';
  if (session.needsAttention) return 'text-orange-500';
  return '';
}
