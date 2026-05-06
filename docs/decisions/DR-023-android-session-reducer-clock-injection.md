# DR-023: Clock-Injected Session Reducer Over Per-Open Refetch

## Status

Accepted

## Context

The Android contacts screen needs PWA-parity session metadata — `modified`, `created`, `messageCount`, `firstMessage`, `cwd` — to render grouped, recency-sorted, richly-labeled session rows. The wire protocol carries those fields on `SessionInfo` (returned by `list_sessions`), but the live event stream does **not**: `session_opened` and `session_replaced` events are bare references to a session id and folder, with none of the rich fields.

The PWA papers over this by issuing a per-session `fetchFullSessionData` round-trip on every `session_opened`. Android has no equivalent path today, and `reduceSessionEvent` is otherwise a pure function whose only non-snapshot input is the event itself.

Two ways to populate the rich fields when a fresh session arrives via the live stream:

1. **Inject a clock into the reducer.** `reduceSessionEvent` takes `now: () -> String`. New rows seed `created = modified = now()` so they sort to the top immediately; `messageCount = 0`, `firstMessage = null`, `cwd = null` until the next refresh corrects them.
2. **Emit a `RefetchFolder` effect on every `session_opened`.** Adds a per-open round-trip and forces every `session_opened` test to also assert an effect, expanding the test matrix significantly.

## Decision

Option 1. The reducer gains a `now: () -> String` parameter; `SessionRepositoryImpl` passes `{ Instant.now().toString() }`; tests pass a fixed-clock lambda.

The refetch-effect path was rejected because the user-visible payoff is small: the existing manual Refresh button and the WS-reconnect bootstrap already converge `messageCount` / `firstMessage` / `cwd` quickly, and the freshly-opened row is sorted correctly the moment it appears. Paying a round-trip per session-open and doubling the assertions on every `session_opened` test is not justified by closing a transient "0 msgs · just now" gap.

## Consequences

- A freshly-opened session shows `0 msgs · just now` until the next refresh — a known transient. Acceptable given the prominent Refresh button and WS-reconnect refresh on the contacts screen.
- The reducer remains pure with respect to its inputs (`snapshot`, `event`, `now`). Tests remain deterministic; the clock is the only non-obvious extra parameter at call sites.
- `session_replaced` must explicitly preserve the old row's rich fields (verbatim copy alongside the existing `name` preservation) — without that, fork/reset would visibly reset `messageCount` and `modified`. This invariant lives in the reducer body and is pinned by `SessionReducerExpandedTest`.
- If the wire protocol later starts carrying `modified` / `messageCount` on `session_opened`, the clock injection becomes redundant: the reducer would consume server values directly and the `now` parameter could be removed.
