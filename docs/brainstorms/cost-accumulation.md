# Brainstorm: Cost Accumulation in the Pimote UI

## The Idea

Surface a running dollar cost in the pimote UI so the user can see what a coding
session is spending. We explored what number to show, where, how accurate it must
be, and how to format it.

## Background (what pi already gives us)

- Every pi **`AssistantMessage`** carries a `usage` object:
  `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`.
  pi **already computes a per-message dollar cost** (`usage.cost.total`, USD) from
  its per-model pricing table. We do **not** need to build or maintain a pricing
  table — we sum what pi hands us.
- Pimote's `server/src/message-mapper.ts` currently **drops** `usage` entirely, so
  no cost data reaches the client today.
- `getContextUsage()` / the existing `contextUsage` session field is a _different_
  thing — context-window occupancy (tokens-in-window %), not spend. Cost is a new,
  parallel concept.

## Key Decisions

### 1. Scope: per-session lifetime total

One running `$` figure per session, summing every assistant turn since the session
began. (Not per-turn, not a global cross-session aggregate.) Rationale: this is the
number the user pictured — "what has this session cost me so far."

### 2. Location: StatusBar, as a sibling of context usage

The figure lives in the **StatusBar** (`client/src/lib/components/StatusBar.svelte`),
treated exactly like the existing **context-usage** indicator:

- **Desktop:** Row 1 (always-visible header row), `md:flex`.
- **Mobile:** Row 2 (the secondary `md:hidden` row), alongside context usage and git
  branch — the established "desktop-row1 → mobile-row2" relocation pattern.

There is no dropdown/overflow menu in StatusBar today; "collapsed into the menu" on
mobile resolves to Row 2. Styling: muted, compact, same visual weight as context
usage. (No per-threshold color escalation — unlike context usage, spend has no
natural "danger" boundary.)

### 3. Accuracy: server-accumulated, correct through compaction

The lifetime total is computed **server-side** as a **pure, idempotent sum of
`usage.cost.total` over all assistant entries in pi's session** — recomputed on each
turn-end and on session load/rebuild. Explicitly **not** a fragile incremental
counter (those double-count on event replay / reconnect).

Why server-side and not a client-side sum of visible messages: pi **compacts** long
sessions, replacing old turns with a summary in the active context. A client that
sums only the messages it currently holds would show the total **drop** after a
compaction — exactly on the long, expensive sessions where the number matters most.
Summing pi's on-disk session entries (which retain the original turns) keeps the
figure correct and monotonic, and it survives reconnects and server restarts.

Transport: a new per-session field carried alongside the existing `contextUsage`,
delivered on the same updates that already refresh session metadata (including
full-resync on reconnect).

### 4. Format: adaptive

- `$1.23` for normal amounts (2 decimals).
- `<$0.01` for a tiny-but-nonzero total (avoids a misleading `$0.00`).
- Hidden entirely when the total is zero (no spend yet).

## Direction (agreed approach)

1. Stop dropping `usage` in the message path; make the server able to read
   `usage.cost.total` from assistant entries.
2. Server computes `lifetimeCostUsd = Σ usage.cost.total` over the session's
   assistant entries (pure function; recompute on turn-end and on load/rebuild).
3. Add a per-session cost field to the protocol next to `contextUsage`; push it on
   the same session-metadata update path, and include it in full-resync.
4. Client stores it on the viewed session (sibling of `contextUsage`) and renders
   an adaptive `$X.XX` in StatusBar — desktop Row 1, mobile Row 2 — shown when > 0.

## Open Questions

1. **Fork semantics.** A forked session inherits the parent's entries, so summing
   the fork's assistant entries includes cost already "paid" in the parent. This
   reads as either "total cost of this conversation lineage" (acceptable) or a
   surprising double-count. Decide during architecture/implementation; not a blocker.
2. **Voice mode.** Interpreter/worker LLM turns (`server/src/voice/`) may or may not
   land as assistant entries in the same pi session. Whether their cost is included
   in the lifetime total needs verifying when wiring up the server-side sum.
3. **Pricing-table fidelity.** We trust pi's `usage.cost.total`. If a model has no
   cost configured (cost fields are `0`), the figure reads `$0` for real spend.
   Acceptable — it reflects what pi knows — but worth noting.
