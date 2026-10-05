/**
 * Decision logic for "the URL wants session X on screen".
 *
 * A session URL can arrive before the registry knows the session: a deep link,
 * a reload that lost the in-memory view, or a notification adoption whose load
 * has not completed. The decision is deliberately load-then-show: never bounce
 * home while the session can still be loaded — the folder need not be known,
 * the server resolves it by id; fall back only after the load was attempted
 * (the server no longer knows the session) or for a client-local placeholder
 * id.
 *
 * Direction matters: the URL only leads on a real navigation (deep link,
 * reload, back/forward). When the registry switches views it navigates the URL
 * one tick later, so on registry-driven re-runs the URL is stale — acting on
 * it would undo the user's click mid-flight (or fall back off a just-rekeyed
 * optimistic id). Those runs wait for the URL to catch up.
 *
 * Pure so the route page stays a thin adapter over goto()/openExistingSession
 * and this contract is unit-testable.
 */

export type SessionRouteDecision =
  /** The URL is behind a registry-led view change — let it catch up first. */
  | { action: 'wait' }
  /** The registry holds the session — adopt it into the view as-is. */
  | { action: 'adopt' }
  /** Load not yet attempted — trigger open_session (the server resolves the folder when the URL doesn't know it), then adopt when it appears. */
  | { action: 'load'; folderPath: string | undefined }
  /** Load failed or unresolvable — show the first active session, or the dashboard when null. */
  | { action: 'fallback'; sessionId: string | null };

export function decideSessionRoute(input: {
  /** The session id the URL asks for. */
  sessionId: string;
  /** The session is already in the registry (adoptRouteView would succeed). */
  inRegistry: boolean;
  /** Folder path from the URL, subscribed sessions, or a prior notification — undefined when unresolvable. */
  folderPath: string | undefined;
  /** A load for this id was already triggered from this route; the registry still doesn't have it. */
  loadAttempted: boolean;
  /** Session ids currently in the registry, used to pick the fallback. */
  activeSessionIds: Iterable<string>;
  /** The URL param changed since the previous decision (deep link, reload, back/forward). */
  urlChanged: boolean;
  /** The registry is navigating the browser toward its chosen view; the URL has not caught up yet. */
  viewNavigationPending: boolean;
}): SessionRouteDecision {
  if (input.viewNavigationPending && !input.urlChanged) return { action: 'wait' };
  if (input.inRegistry) return { action: 'adopt' };
  // Optimistic placeholders (pending-*) are client-local fictions the server
  // can never resolve — fall back instead of asking. They are not fallback
  // targets either (below).
  if (!input.loadAttempted && !input.sessionId.startsWith('pending-')) return { action: 'load', folderPath: input.folderPath };
  if (input.folderPath && !input.loadAttempted) return { action: 'load', folderPath: input.folderPath };

  // Optimistic placeholders (pending-*) are not real sessions to fall back onto.
  const fallback = [...input.activeSessionIds].find((id) => !id.startsWith('pending-')) ?? null;
  return { action: 'fallback', sessionId: fallback };
}
