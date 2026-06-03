# Plan: Cost Accumulation in the Pimote UI

## Context

Surface a per-session lifetime dollar cost in the pimote StatusBar so the user can
see what a coding session has spent. pi already computes a per-message cost
(`AssistantMessage.usage.cost.total`, USD); we sum it. See
`docs/brainstorms/cost-accumulation.md` for scope, accuracy, placement, and format
decisions.

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/protocol.ts`) — extend the existing `SessionMeta`
  interface with a `lifetimeCostUsd: number` field (USD, `0` when no spend). Cost is
  the twin of the existing `contextUsage` field and rides the same carrier; no new
  command or event type is introduced.

- **Server** (`server/src/`) — the `get_session_meta` handler in `ws-handler.ts`
  computes `lifetimeCostUsd` alongside `contextUsage`, by summing `usage.cost.total`
  over assistant message entries from `session.sessionManager.getBranch()` (the same
  in-memory branch traversal already used by the `get_messages` handler). The sum is
  a pure recompute on each meta fetch — not an incremental accumulator — which is
  idempotent (no double-counting on replay/reconnect) and cheap (the entries are
  already in RAM; the session is opened once into the `SessionManager`'s in-memory
  tree and is append-only). The figure also survives a server restart for free: on
  reopen the `SessionManager` rehydrates the full branch from the on-disk JSONL
  session file, so the recompute yields the same total. A new pure helper module owns
  the summation so it is unit testable in isolation.

- **Client** (`client/src/`) — the per-session state object
  (`session-registry.svelte.ts`) gains a `lifetimeCostUsd` field, set by
  `updateMeta` from the incoming `SessionMeta` (the meta refresh already fires on
  `agent_end`, session open, switch, and reconnect — no new refresh triggers needed).
  `StatusBar.svelte` renders the formatted cost as a sibling of the context-usage
  indicator: desktop Row 1 (`md:flex`), mobile Row 2 (`md:hidden`), muted styling,
  shown only when there is nonzero spend. A pure formatting helper produces the
  adaptive display string.

### New Modules

- **`server/src/session-cost.ts`** — pure cost summation helper. Owns
  `sumAssistantCostUsd(entries)`: given a session branch (array of session entries),
  returns the total USD cost summed over assistant message entries. No I/O, no SDK
  session coupling beyond a structural type. Colocated test:
  `server/src/session-cost.test.ts`.

  (Client-side formatting may live in a small new helper, e.g.
  `client/src/lib/format-cost.ts`, or alongside the existing display helpers in
  `client/src/lib/session-summary.ts` — the test writer/implementer chooses placement;
  the contract is below.)

### Interfaces

**Protocol — `SessionMeta` (extended):**

```ts
export interface SessionMeta {
  gitBranch: string | null;
  contextUsage: { percent: number | null; contextWindow: number } | null;
  lifetimeCostUsd: number; // total USD over the session branch; 0 when no spend
}
```

`lifetimeCostUsd` is always a number (never null). `0` is the sentinel for "no spend
/ nothing to show". A model with no configured pricing yields `0` even for real
token usage (pi reports `cost.total === 0`); this is accepted (see Open Questions).

**Server — `sumAssistantCostUsd` (pure):**

```ts
// Structural view of the session entries this helper consumes. Mirrors the
// duck-typed approach in message-mapper.ts (SdkSessionEntry) — only the fields
// needed are declared.
interface CostBranchEntry {
  type: string; // 'message' | 'compaction' | ... ; only 'message' contributes
  message?: {
    role?: string; // only 'assistant' contributes
    usage?: { cost?: { total?: number } };
  };
}

// Sum usage.cost.total over assistant message entries in the branch.
// - Skips non-'message' entries (compaction, model-change, labels, etc.).
// - Skips non-assistant messages (user, toolResult).
// - Missing/undefined usage or cost contributes 0.
// - Returns a finite number >= 0. Empty branch => 0.
function sumAssistantCostUsd(entries: CostBranchEntry[]): number;
```

Behavioral expectations the test writer should pin:

- Empty array → `0`.
- A branch with assistant entries of costs `0.01`, `0.02` → `0.03` (floating sum;
  exact-equality tolerance is the implementer's call, but the documented contract is
  a straight sum).
- User messages, toolResult messages, and non-`message` entries → ignored.
- Assistant entry with `usage` absent, or `cost` absent, or `cost.total` absent →
  contributes `0`, does not throw.
- Pre-compaction assistant entries that remain on the branch are counted (compaction
  adds a separate entry and does not remove prior message entries), so the total is
  monotonic across a compaction.

**Server — `get_session_meta` handler (behavior):**
Produces a `SessionMeta` whose `lifetimeCostUsd` equals
`sumAssistantCostUsd(session.sessionManager.getBranch())`, computed alongside the
existing `gitBranch` and `contextUsage` fields.

**Client — cost formatting (pure):**

```ts
// Adaptive display for the session cost figure.
// - usd <= 0            → null (caller hides the indicator)
// - 0 < usd < 0.01      → "<$0.01"
// - usd >= 0.01         → "$" + usd.toFixed(2)   (e.g. "$1.23", "$0.04")
function formatSessionCost(usd: number): string | null;
```

Behavioral expectations:

- `0` → `null`; negative (shouldn't occur) → `null`.
- `0.004` → `"<$0.01"`; `0.0001` → `"<$0.01"`.
- `0.01` → `"$0.01"`; `1.235` → `"$1.24"` (or `"$1.23"` — rounding mode is the
  implementer's call; pin one in the test); `12` → `"$12.00"`.

**Client — `Session` state + `updateMeta` (behavior):**
The session state object carries `lifetimeCostUsd: number` (initialized `0`).
`updateMeta(sessionId, meta)` assigns `session.lifetimeCostUsd = meta.lifetimeCostUsd`
alongside the existing `session.contextUsage = meta.contextUsage`.

**Client — `StatusBar.svelte` (behavior):**
Renders `formatSessionCost(viewed.lifetimeCostUsd)` when non-null: as a muted span in
the desktop Row 1 group (`md:flex`, near the context-usage span) and in the mobile
Row 2 group (`md:hidden`, alongside context usage / git branch). Hidden entirely when
`formatSessionCost` returns null.

## Open Questions

1. **Fork semantics.** A forked session's branch includes inherited parent entries,
   so `sumAssistantCostUsd(getBranch())` includes cost already "paid" in the parent.
   This reads as "total cost of this conversation lineage." Accepted as a natural
   consequence of summing the branch; revisit only if it proves confusing in use.
2. **Voice mode.** Only assistant entries that actually land on the session branch
   are counted. Whether interpreter/worker voice turns appear as branch entries with
   `usage` should be eyeballed during implementation; no special-casing is planned —
   they count if and only if they're on the branch.
3. **Models without pricing.** `cost.total === 0` for unpriced models yields `$0`
   (hidden) even with real token spend. Accepted — the figure reflects what pi knows.
