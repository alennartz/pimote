# DR-087: Server-projected typed subagent transcripts

## Status

Accepted

## Context

DR-086 gave Pimote typed providers, borrowed child views, and independent cursors, but kept native Pi entries as the client transcript source and rendered semantic overlays beside them. That split made the client reconcile two event streams. Progressive replacements could flicker, lose their native content slot, or diverge during reconnect and hydration.

The completed workflow keeps Pi as the persistence authority while moving transcript projection to the server. The server must combine native content and provider-owned subagent meaning before transmission, without making Pimote parse extension details or router messages.

> Supersedes DR-086 (Typed provider with borrowed child views), deleted at commit `bf08856f9a782f09373855a7ae6396113f51981e`.

## Decision

Keep DR-086's ownership decisions: one provider per root, borrowed child-session leases, path and incarnation guards, independent root and child surfaces, independent cursors, and my-pi ownership of child lifecycle and persistence. Replace only its transcript-source and rendering decision.

Each session surface owns one server-side transcript projector. It accepts the native Pi stream, an immutable provider replacement manifest, and typed provider operations. It suppresses declared native tool and custom-message renderers, inserts typed `subagent` content into the original assistant content slot, and preserves all other native content in source order. A custom-entry payload stays at its entry position and keeps its payload order.

The SDK provider feed is the presentation seam. It carries typed finite snapshots, progressive start/delta/end operations, accumulated active state, placement, and idempotent native-session hydration. Router correlation IDs, partial JSON, XML, native result text, and physical session IDs stay outside that seam. Pimote hydrates the native session first, calls the provider's `rehydrate` boundary, and releases the first projected snapshot only after both are ready. The server event buffer remains a generic replay cursor for already projected events; reconnect snapshots restore accumulated active state instead of replaying delta history.

The wire protocol takes a hard cut to typed `subagent` content and dedicated lifecycle events. A missing adapter lifecycle produces a visible protocol-error block. The client renders projected content inline and does not perform native matching, persisted-detail parsing, or overlay reconciliation.

We rejected client-side overlays because they duplicate the native row and make ordering, reconnect, and hydration depend on two competing sources. We rejected client parsing of native details because extension-owned meaning would leak through a model-facing persistence format. We rejected a second transcript or journal because it would duplicate Pi persistence and create another writer. The generic panel surface remains separate from first-party subagent transcript content.

## Consequences

- Mixed assistant rows keep native text, typed subagent content, and unrelated native tools in their original order.
- Pi remains the general reload and persistence authority, while my-pi interprets its own persisted payloads and publishes typed final operations.
- Progressive deltas are live-only. Reconnect and replay restore complete blocks and accumulated active state.
- The projector and presentation schemas add implementation surface, and every client mirror must accept the hard wire cut.
- The provider must supply deterministic typed operations for live validation. The completed manual run could hydrate persisted root content but could not verify live child streaming because no live provider and child-lease fixture was available.
- The shared-observer smoke also retained two unrelated open failures: observer queue order and late-observer replay of the final bash result. Those failures remain outside this decision's projection scope.
