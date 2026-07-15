# `entry_appended` refactor — persisted entries as the source of truth

## Idea

Remove pimote's fragile reconciliation of streamed `AgentMessage`s with
persisted session-entry IDs. Entry IDs back fork and tree-navigation targets,
so an off-by-one error after a barge-in breaks durable navigation.

## Context discovered

The existing design receives live `message_*` events, then at `agent_end`
reconstructs entry identity from `getBranch()`:

- `extractMessageEntryIds()` duplicates the SDK's compaction-aware context
  ordering.
- `applyEntryIds()` zips those IDs onto `agent.state.messages` and must skip
  synthetic empty aborted-assistant placeholders, which are never persisted.
- The client repeats that same placeholder-skip alignment when consuming
  `agent_end.messageEntryIds`.

The original plan assumed SDK 0.80.7's `entry_appended` was an authoritative
persistence stream. It is not: in the installed/latest SDK it is emitted only
when an extension calls `appendEntry()` for a custom entry. Regular message,
custom-message, bash, and compaction persistence do not emit it. Further,
SDK listeners receive `message_end` before the SDK persists that message.
Upstream pi changes are out of scope.

The SDK already exposes `SessionManager.buildContextEntries()`. It returns the
SDK's own compaction-aware context ordering, and each `SessionMessageEntry`
pairs a persisted `id` with its `message`.

## Key decisions

### Persisted entries define durable message views

`get_messages` and `full_resync` should derive rendered messages from
`buildContextEntries()`, preserving each entry's ID alongside its mapped
message. They must no longer start from `agent.state.messages` and zip in IDs.

**Why:** it removes both the aborted-placeholder heuristic and pimote's copy
of SDK compaction ordering. The SDK, rather than pimote, determines which
persisted entries constitute the current context.

### Keep live deltas, but make the server own identity correlation

Streaming deltas remain the live-rendering path. Once a streamed message is
known to be persisted, the server must associate it with its entry ID and
communicate that identity directly to the client. The client must not perform
a positional or role-based alignment pass at `agent_end`.

**Why:** token rendering needs deltas; persistence is entry-granular. Keeping
correlation server-side isolates SDK timing details and eliminates the
client's duplicated correctness rule.

### Accept persisted-truth behavior after an abort

Empty aborted placeholders and unpersisted aborted partial content will not
appear in entry-derived resync/reopen views.

**Why:** these objects are not session history and already disappear after a
server restart. Durable and rehydrated views should agree on persisted truth,
rather than expose transient `agent.state.messages` leftovers.

### Do not use SDK `entry_appended` for this feature

Leave it without a wire representation for now.

**Why:** it does not report normal persistence, so treating it as
authoritative would silently omit ordinary conversation entries.

## Direction

Replace all snapshot-time ID reconciliation with direct, entry-derived message
mapping based on `buildContextEntries()`. Replace the current
`agent_end.messageEntryIds` batch alignment with a server-authored,
per-message persistence association for the live path. Retire
`extractMessageEntryIds`, `applyEntryIds`, and the matching client loop once
that association is in place.

The client remains a streamed-message renderer; a wholesale client
entries-as-truth rewrite was considered but rejected as unnecessary for the
benefit. The durable source of truth moves to entries on the server, while
streaming stays an overlay until persistence is confirmed.

## Success

- No fork/tree target can be shifted by an aborted placeholder.
- `get_messages`, full resync, and live streaming all give persisted messages
  the entry IDs that actually own them.
- Pimote has no replicated compaction-ordering or aborted-placeholder
  alignment logic.
- Fork and tree navigation work across a barge-in and reconnect.

## Open questions

### Sharp technical questions for architecture

1. **Live association protocol and ordering:** Because SDK `message_end` is
   delivered before persistence, decide how the server safely learns the
   just-persisted entry and links it to the exact prior wire message without
   an event-loop timing race. Define its replay-safe wire representation
   (for example, an explicit persistence event keyed to a stable
   server-assigned message identity) and client application rule.
2. **Entry-to-render mapping:** Define the one entry-derived mapper over the
   full `buildContextEntries()` union. It must preserve the existing visible
   semantics for message, custom-message, compaction summary, and branch
   summary entries while deliberately excluding non-rendered entries.
3. **Replay boundary:** Specify how the new live-association event enters the
   `EventBuffer`, how coalesced replay stays ordered, and why a full resync
   can safely supersede any unmatched transient stream state.

### Fog

- Whether the final protocol should call the live association
  `message_persisted`, `message_entry`, or another name. The name should
  follow from the chosen correlation and replay contract.
