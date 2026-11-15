# DR-088: Chip order and session selection are per-user profile state

## Status

Accepted

## Context

The per-user open-session pull moved `pimote:activeSessions` into the server: `UserProfiles` holds one JSON document keyed by user, mutations are `link`/`unlink`/`unlinkAll`, and `user_sessions_changed` pushes the resulting set to that user's other connections. Two facts stayed local.

**Chip order was implicit.** The client rendered `activeSessions` in `Object.values` insertion order, so the bar's order depended on the order this page happened to load sessions. Reopening a session, or opening the app on a second device, reshuffled the bar.

**Selection was per connection.** `view_session` set `viewedSessionId` on the socket and cleared `needsAttention` on the slot. Two connections of one user could sit on different sessions, and the user had no way to say "this is the session I am on" once and have both follow.

The profile mutations were deliberately per-session operations that commute, so two connections could open and close sessions concurrently without dropping each other's changes. A chip order does not commute: it is one fact about the whole sequence.

## Decision

**Both facts live in the user profile, beside the open-session set.**

Order is a whole-order write, versioned. The client owns the resulting order, sends the full ordered id list plus the `orderVersion` it computed against, and the server persists it after normalizing it to the set: ids outside the set drop, and set members the list omits append. A write whose `baseVersion` is no longer current is refused and the actor is handed the current facts. Two simultaneous reorders therefore resolve last-writer-wins, one order surviving whole with no merge.

Selection is one fact per user. `view_session` sets it, and `user_sessions_changed` carries it beside the set and the order, so a selection change reaches every connection of that user through the one event and one reconcile path the pull already had. A selected session is always a member of the set: viewing a session the profile does not hold links it first. Because selection is user-level, attention is too — selecting clears `needsAttention` for the whole user, not just the socket that clicked.

A connection receiving a selection it does not show navigates there. The follow is a navigation, not a prompt: the receiving view changes even mid-task, the pending run continues, and unsent text and open dialogs are kept for the return. A connection that reconnects lands on the user's selected session from the connect burst, so missed follows are never replayed one by one.

Two reorder mechanics ship, and the mobile tray decides which one is live: with the tray closed a hold lifts a chip and the drag shows an insert-line marker; with the tray open the selected chip pins at the rail centre and the other chips flow around it, one pass per swipe step. Both mechanisms issue the same whole-order write. Desktop keeps pointer drag with the marker.

We rejected reusing per-session commuting ops for order (a move operation against an implicit order leaves two connections disagreeing about what the sequence was), requiring the client to send move offsets, and merging per-client order fragments: the first is not expressible as a commuting op, and the other two buy correctness for a case — two reorders inside one round trip — that costs more than the loss it prevents.

We rejected a separate `selection_changed` event. Selection changes far more often than the set, so a dedicated event would be lighter, but it also splits the reconcile path in two for a client that must already apply set changes.

We rejected keeping selection per connection and syncing it as a hint. The user's intent is to be on one session across devices; a highlight-only model leaves every device on a different session and the bar divided.

## Consequences

- A reorder is a rare write next to open and close, and its loser loses only the order. This is the first deliberate departure from the commuting-ops convention; a second whole-set mutation elsewhere would end that convention rather than extend it.
- Every selection change re-delivers the full profile event to every connection of the user, and each of them navigates. That is the accepted cost of one code path.
- The bar's order survives a reload, a restart, and a second device. Order is per user, not per device: a phone and a desktop of one user share chip order while showing different widths.
- A connection can have its view replaced by another connection's selection. This is a real daily-UX change: the pending run is untouched, and drafts are preserved, but the view moves.
- Missing entries append to the order when a session is linked, so a new session lands at the end and no re-sort ever runs.
- The stored order and the stored selection are normalized on load and on every set mutation, so a session dropped by close, archive, delete, rekey, or the boot sweep leaves no stale id behind.
