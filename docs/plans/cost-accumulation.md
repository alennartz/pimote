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

## Tests

**Pre-test-write commit:** `0dda89d0f9f3b4cd92927bcc70f37e6e8eec9395`

### Interface Files

- `shared/src/protocol.ts` — extended `SessionMeta` with `lifetimeCostUsd: number` (USD, `0` when no spend; always a number, never null).
- `server/src/session-cost.ts` — new pure helper module. Defines `CostBranchEntry` (duck-typed structural view of a session branch entry) and `sumAssistantCostUsd(entries): number` (stub throwing `"not implemented"`).
- `server/src/ws-handler.ts` — `get_session_meta` handler wired to populate `lifetimeCostUsd` via `sumAssistantCostUsd(session.sessionManager.getBranch())`; imports the new helper.
- `client/src/lib/session-summary.ts` — new `formatSessionCost(usd): string | null` (stub throwing `"not implemented"`).
- `client/src/lib/stores/session-registry.svelte.ts` — `PerSessionState` gains `lifetimeCostUsd: number`, initialized to `0` in `createSessionState`. (`updateMeta` not yet wired to assign it — that is implementation.)

### Test Files

- `server/src/session-cost.test.ts` — behavioral tests for `sumAssistantCostUsd`: empty/trivial inputs, summation over assistant entries, filtering of non-assistant and non-message entries, missing/malformed cost data, and contract guarantees including monotonicity across compaction.
- `client/src/lib/session-summary.test.ts` — behavioral tests for `formatSessionCost`: zero/negative sentinel, sub-cent display, and cent-and-above formatting/rounding.
- `client/src/lib/stores/session-registry.test.ts` — added tests asserting `updateMeta` assigns `lifetimeCostUsd` to the target session only (session-specific, not folder-level) and that new session state initializes it to `0`. (Existing `updateMeta` test literal updated to include `lifetimeCostUsd`.)

### Behaviors Covered

#### Server — `sumAssistantCostUsd`

- Empty branch → `0`.
- Branch of only non-assistant entries (user, toolResult, compaction) → `0`.
- Sums `message.usage.cost.total` across assistant message entries (e.g. `0.01 + 0.02 → 0.03`).
- A single assistant entry returns its cost unchanged.
- User and toolResult messages are ignored.
- Non-`message` entries (compaction, model-change, label) are ignored even if they carry an assistant-shaped payload.
- Assistant entry with missing `usage`, missing `cost`, or missing `cost.total` contributes `0` and does not throw.
- A `message` entry with no `message` field does not throw.
- Result is always a finite number `>= 0`.
- Pre-compaction assistant entries that remain on the branch are still counted alongside post-compaction ones (total is monotonic across a compaction).

#### Client — `formatSessionCost`

- `0` → `null`; negative → `null` (caller hides the indicator).
- `0 < usd < 0.01` → `"<$0.01"` (e.g. `0.004`, `0.0001`).
- `0.01` → `"$0.01"`; `0.04` → `"$0.04"`; `1.23` → `"$1.23"`.
- Rounds to two decimals (`1.235` → `"$1.24"`; rounding mode pinned to `toFixed(2)`).
- Whole-dollar amounts padded to two decimals (`12` → `"$12.00"`).

#### Client — `SessionRegistry` cost state

- New session state initializes `lifetimeCostUsd` to `0`.
- `updateMeta(sessionId, meta)` assigns `meta.lifetimeCostUsd` to the target session only — it is session-specific (like `contextUsage`), not propagated folder-wide (unlike `gitBranch`).

**Review status:** approved

## Steps

**Pre-implementation commit:** `b7212414cae362213f271cf8d3e07d5dcb4b39c3`

The architecture's interface files are already in place from the test-write phase:
`SessionMeta.lifetimeCostUsd` exists in the protocol; `ws-handler.ts`'s
`get_session_meta` handler already calls
`sumAssistantCostUsd(session.sessionManager.getBranch() as unknown as CostBranchEntry[])`;
`PerSessionState.lifetimeCostUsd` exists and is initialized to `0` in
`createSessionState`. The remaining work is filling in the two pure-function stubs
(currently throwing `"not implemented"`), wiring `updateMeta` to assign the field,
and rendering it in the StatusBar. Each step makes existing tests pass; no new tests.

### Step 1: Implement `sumAssistantCostUsd` in `server/src/session-cost.ts`

Replace the stub body of `sumAssistantCostUsd(entries: CostBranchEntry[]): number`
(remove the `throw new Error('not implemented')`; rename `_entries` → `entries`).
Sum `message.usage.cost.total` over entries where `type === 'message'` and
`message.role === 'assistant'`. Treat any missing link in the
`message?.usage?.cost?.total` chain as `0` (use `?? 0`), and skip non-message /
non-assistant entries entirely. The result must be a finite number `>= 0` for an
empty branch (`0`).

**Verify:** `cd server && npx vitest run src/session-cost.test.ts` — all cases in
`server/src/session-cost.test.ts` pass (empty/trivial, summation, filtering,
malformed-cost, monotonic-across-compaction).
**Status:** done

### Step 2: Implement `formatSessionCost` in `client/src/lib/session-summary.ts`

Replace the stub body of `formatSessionCost(usd: number): string | null` (remove the
`throw`; rename `_usd` → `usd`). Return `null` when `usd <= 0`; `"<$0.01"` when
`0 < usd < 0.01`; otherwise `"$" + usd.toFixed(2)`. `toFixed(2)` is the pinned
rounding mode (the test expects `1.235 → "$1.24"`, `12 → "$12.00"`).

**Verify:** `cd client && npx vitest run src/lib/session-summary.test.ts` — all
`formatSessionCost` cases pass (no-spend sentinel, sub-cent, cent-and-above).
**Status:** done

### Step 3: Assign `lifetimeCostUsd` in `updateMeta`

In `client/src/lib/stores/session-registry.svelte.ts`, `updateMeta(sessionId, meta)`
currently assigns only `session.contextUsage`. Add
`session.lifetimeCostUsd = meta.lifetimeCostUsd;` alongside it (session-specific, like
`contextUsage` — do NOT propagate it folder-wide the way `gitBranch` is). Update the
method's doc comment to mention cost.

**Verify:** `cd client && npx vitest run src/lib/stores/session-registry.test.ts` —
the `updateMeta() assigns lifetimeCostUsd to the target session only` and
`session state initializes lifetimeCostUsd to 0` tests pass, and the existing
git-branch-propagation test still passes.
**Status:** done

### Step 4: Render the cost in `StatusBar.svelte`

In `client/src/lib/components/StatusBar.svelte`:

1. Import `formatSessionCost` from `$lib/session-summary.js` (extend the existing
   import line that already pulls `getContextDisplay`, `getContextTone`,
   `getSessionDisplayName`).
2. Add a derived value near the existing `contextDisplay`:
   `let costDisplay = $derived(formatSessionCost(sessionRegistry.viewed?.lifetimeCostUsd ?? 0));`
3. **Desktop (Row 1):** add a muted span as a sibling of the desktop context-usage
   span (the `hidden items-center gap-1 md:flex` block, ~line 78), guarded by
   `{#if costDisplay}`, styled `text-muted-foreground hidden items-center gap-1 md:flex`,
   with `title="Session cost"`, rendering `{costDisplay}`.
4. **Mobile (Row 2):** add a matching span as a sibling of the mobile context-usage
   span (the `flex shrink-0 items-center gap-1` block, ~line 160), guarded by
   `{#if costDisplay}`, styled `text-muted-foreground flex shrink-0 items-center gap-1`,
   `title="Session cost"`, rendering `{costDisplay}`. Also add `|| costDisplay` to the
   Row 2 wrapper's `{#if sessionDisplayName || ... || contextDisplay}` visibility
   guard so the row appears when cost is the only populated field.

The indicator is hidden whenever `formatSessionCost` returns `null` (zero/no spend).

**Verify:** `cd client && npx vitest run` passes (no StatusBar unit test, but the
suite must stay green). Manually: a session with nonzero spend shows `$X.XX` muted in
Row 1 (desktop) / Row 2 (mobile); a fresh session shows nothing.
**Status:** done

### Step 5: Typecheck and full test sweep

Run the server and client typechecks/tests to confirm the stub removals and StatusBar
edit introduce no type or test regressions across the touched workspaces.

**Verify:** `cd server && npx tsc --noEmit && npx vitest run` and
`cd client && npx svelte-check && npx vitest run` both pass.
**Status:** done
