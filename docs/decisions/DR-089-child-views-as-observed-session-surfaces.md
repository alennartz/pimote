# DR-089: Child views sync as observed session surfaces

## Status

Accepted

## Context

A child view was owned by the connection that opened it: the socket held the surface, the attachment generation, and the provider lease. On reconnect the server rebuilt the surface and pushed a snapshot. When the socket was gone, that push had nowhere to land. A `subagent_view_closed` sent to a dead socket was never replayed, the client kept a view that no longer existed server-side, and clicking the child again re-selected the dead view (BUG-014). The client also received events for a surface whose cursor restarted at zero, so two surfaces could not be ordered against each other.

A child session is a session. The root already had the machinery the child lacked: one surface per session, observers keyed by client, cursor replay with a snapshot fallback (DR-077), and a stored cursor the client sends back. Child transcripts are not small; the snapshot-per-reconnect cost the root avoids was being paid on every child reconnect.

The idle hold also keyed off the wrong thing. The provider's hold lives while a lease is attached, so "is a person watching this child" was answered by counting connection records, not observers.

## Decision

Own one child surface per `(rootSessionId, path)`, with observers keyed by client. The surface and the provider lease live while at least one observer is attached, and the last detach releases both. Two windows, or two users, sharing a child then share one transcript, one replay buffer, and one lease.

Sync mirrors the root. `subagent_open_view` carries the client's last child cursor; the server replays the delta after it, or sends a snapshot when the cursor cannot reach. Payloads travel as view frames ahead of the response, so the client never depends on an unsolicited push. A path the host cannot serve answers `subagent_view_unavailable`, and the client closes the view through that response. The client reattaches every open view after a reconnect, because socket death detaches its observers and a locally open attachment proves nothing.

Open views join the user profile beside open sessions. `subagent_open_view` links, `subagent_close_view` unlinks, a root's close, delete, archive, or detach takes its views with it, and boot drops every view. A view's identity is its root plus its root-relative path; the stored child session id is informational.

`attachmentGeneration` disappears from the wire. `incarnation` stays as the runtime guard for commands, not as sync identity.

A rebuilt surface starts strictly above the cursor of the surface it replaces, so a live client's last position reads as stale and yields a snapshot. A record created after a drop starts at the wall clock, the rule root slots already use.

Rejected: keep connection-owned views and push the authoritative attachment set on reconnect. It restates root sync in a second vocabulary, keeps a generation as sync identity, duplicates a surface per observer, and still needs a fallback for a close that was sent to a dead socket.

Rejected: keep snapshots as the only child payload and send a cursor for information. Child transcripts grow to hundreds of kilobytes, and the surface buffer that makes deltas cheap already existed.

Rejected: let each client remember its own child views locally. The per-user open set exists so a second device sees what the first has open.

## Consequences

- A socket close detaches its observers, so a child that settles while every app is closed delivers its idle notification to the parent. This supersedes the retention half of `6f81439` (BUG-012); the rule that an unavailable view does not mark a running child stopped stands. The accepted cost: a settle during a gap is visible to the parent earlier than the old retention rule allowed.
- Views do not survive a server restart. A view needs a live borrowed runtime, and no root slot rebuilds one at boot.
- A transient provider failure no longer removes a view from the profile; only an absent path does.
- Client attachment state is a view of server truth. Any future client cache must reconcile through an open response rather than assume its own copy.
- Two observers of one child share a surface, so a tree navigation refreshes both. That is intended and now costs one refresh.
- Android decodes the view frames and drops them. Removing an optional field needs no lockstep release.
- The hard cut breaks any out-of-tree client that sends `attachmentGeneration`.
