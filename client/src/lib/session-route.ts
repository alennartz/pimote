/**
 * Decision logic for "the URL wants session X on screen".
 *
 * A session URL can arrive before the registry knows the session: a deep link,
 * a reload that lost the in-memory view, or a notification adoption whose load
 * has not completed. The decision is deliberately load-then-show: never bounce
 * home while the session can still be loaded; fall back only after the load
 * was attempted (the session no longer exists) or when nothing can resolve the
 * id at all.
 *
 * Pure so the route page stays a thin adapter over goto()/openExistingSession
 * and this contract is unit-testable.
 */

export type SessionRouteDecision =
  /** The registry holds the session — adopt it into the view as-is. */
  | { action: 'adopt' }
  /** Folder known and load not yet attempted — trigger open_session, then adopt when it appears. */
  | { action: 'load'; folderPath: string }
  /** Load failed or unresolvable — show the first active session, or the dashboard when null. */
  | { action: 'fallback'; sessionId: string | null };

export function decideSessionRoute(input: {
  /** The session is already in the registry (adoptRouteView would succeed). */
  inRegistry: boolean;
  /** Folder path from the URL, subscribed sessions, or a prior notification — undefined when unresolvable. */
  folderPath: string | undefined;
  /** A load for this id was already triggered from this route; the registry still doesn't have it. */
  loadAttempted: boolean;
  /** Session ids currently in the registry, used to pick the fallback. */
  activeSessionIds: Iterable<string>;
}): SessionRouteDecision {
  if (input.inRegistry) return { action: 'adopt' };
  if (input.folderPath && !input.loadAttempted) return { action: 'load', folderPath: input.folderPath };

  // Optimistic placeholders (pending-*) are not real sessions to fall back onto.
  const fallback = [...input.activeSessionIds].find((id) => !id.startsWith('pending-')) ?? null;
  return { action: 'fallback', sessionId: fallback };
}
