/**
 * The user's shared session facts: chip order and the selected session. One
 * `user_sessions_changed` carries both (D4), because they are one user-level
 * truth that every connection of the user reconciles in the same pass.
 *
 * Pure so the registry stays a thin adapter over these decisions.
 */

/** One event's worth of user-level session facts. */
export interface UserSessionFacts {
  /** Every open session id in chip order. */
  order: readonly string[];
  /** The user's selected session, or null when none is selected. */
  selectedSessionId: string | null;
  /** Epoch of `order`, echoed as `baseVersion` on the next whole-order write. */
  orderVersion: number;
}

/**
 * Project sessions into the chip order. Ids the registry does not hold drop
 * out, and sessions the order omits append in registry order — a newly opened
 * session therefore lands at the end without a re-sort (D6).
 */
export function projectChipOrder<T extends { sessionId: string }>(sessions: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const projected: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const session = byId.get(id);
    if (!session || seen.has(id)) continue;
    seen.add(id);
    projected.push(session);
  }
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    projected.push(session);
  }
  return projected;
}

/** Move one id to another index. A move that cannot happen returns the order
 *  unchanged, so a caller can compare before pushing a whole-order write. */
export function moveChipOrder(order: readonly string[], fromIndex: number, toIndex: number): string[] {
  const next = [...order];
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= next.length || toIndex >= next.length) return next;
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export type FollowDecision =
  /** The selection is a session this connection can view and does not. */
  | 'navigate'
  /** No selection, an unknown id, or the view already matches it. */
  | 'stay';

/**
 * Whether a user-level selection moves this connection's view (D1). Staying
 * put when the view already matches is what breaks the loop: a follow must
 * never answer with its own `view_session`.
 */
export function followDecision(input: { selectedSessionId: string | null; viewedSessionId: string | null; knownSessionIds: Iterable<string> }): FollowDecision {
  if (!input.selectedSessionId) return 'stay';
  if (input.selectedSessionId === input.viewedSessionId) return 'stay';
  for (const id of input.knownSessionIds) {
    if (id === input.selectedSessionId) return 'navigate';
  }
  return 'stay';
}
