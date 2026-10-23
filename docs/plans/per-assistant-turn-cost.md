# Plan: Per-assistant-message cost visualization

## Context

The PWA needs a cost summary for each assistant message row and one complete session total. The brainstorm settles the product contract and the [cost breakdown design](../brainstorms/per-assistant-turn-cost.md).

## Architecture

### Impacted Modules

- **Protocol** — Add a serializable usage shape to assistant and tool-result messages, streaming snapshots, and `SessionMeta`. Remove the next-roundtrip forecast field. Keep the shared protocol independent of Pi imports and leave Android unchanged.
- **Server** — Adapt Pi usage at the SDK seam. Map assistant and tool-result usage through live events and persisted context. Use `AgentSession.getSessionStats().cost` as the session total and expose a category-only rollup from the same persisted entries. Remove the custom lifetime scalar sum and forecast calculation.
- **Web Client** — Store usage snapshots with streamed and finalized messages. Derive each assistant row’s cost from its own usage and matching tool-result usage. Render the approved cost disclosure in the transcript, status bar, and mobile session settings.
- **Development Tooling** — Update mapper, session-state, metadata, and UI coverage. Extend the cost smoke to cover categories, tool correlation, transient abort usage, resync, and reload.

### New Modules

- **Server session usage projection** (`server/src/session-usage.ts`) — A pure reducer over real Pi `SessionEntry` values. It returns token totals from `SessionStats` and dollar totals by input, output, cache read, and cache write. It does not compute or replace Pi’s scalar total. It replaces the custom total helper.
- **Assistant-row usage projection** (`client/src/lib/assistant-row-usage.ts`) — A pure Web Client module that accepts the current message snapshot. It indexes tool-result usage by `toolCallId`, then returns an aggregate for each assistant message row. It derives from message state and does not increment counters.
- **Cost breakdown popover** (`client/src/lib/components/CostBreakdownPopover.svelte` and `client/src/lib/components/ui/popover/`) — A reusable Web Client interface with one numeric trigger and one category breakdown view. Use the Bits UI Popover primitive through Pimote’s local UI-wrapper pattern.

### Interfaces

#### Pi messages to Pimote wire messages

The server maps the Pi SDK’s real `Usage` type at `message-mapper.ts`. The wire type remains self-contained:

```ts
interface PimoteUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

`PimoteAgentMessage.usage` is optional and carries this shape for `assistant` and `toolResult` messages. Other roles omit it. `cacheWrite1h` is a subset of cache-write tokens. `reasoning` is a subset of output tokens. Neither becomes a separate cost category.

The shared summary shape is:

```ts
interface PimoteUsageBreakdown {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface AssistantRowUsage {
  totalCostUsd: number;
  breakdown: PimoteUsageBreakdown;
}
```

The row projection returns `AssistantRowUsage | null`. `SessionMeta.usageBreakdown` carries `PimoteUsageBreakdown`; `lifetimeCostUsd` remains its separate scalar total.

`MessageStartEvent` and `MessageUpdateEvent` carry an optional full usage snapshot from the Pi event’s current assistant message. Forward snapshots only when the token and cost fields are finite and nonnegative; do not add a provider allowlist. `StreamingMessage.usage` stores the latest snapshot. The client replaces snapshots; it never adds them. If Pi exposes no partial usage, the client waits for completion. `MessageEndEvent.message.usage` is final and replaces partial data. Final usage survives incremental replay, full resync, reconnect, and reload because Pi persists the message. Full resync also maps usage from the in-flight SDK message.

#### Assistant-row projection

The client derives the row summary from the assistant message and the current session transcript:

```ts
summarizeAssistantRowUsage(
  assistant: PimoteAgentMessage | StreamingMessage,
  messages: readonly PimoteAgentMessage[],
): AssistantRowUsage | null
```

The projection adds the assistant response usage and `usage` from each `toolResult` whose `toolCallId` matches a `tool_call` block in that row. It sums token counts and cost categories, including multiple matching tool results. A later assistant message remains a separate row. Ordinary tool-result text has no usage; its model-input cost appears in the later assistant request’s usage.

The result includes the summed `cost.total`, token counts, and input/output/cache-read/cache-write cost categories. If the total exceeds the category sum by more than $0.01, the popover shows the positive remainder as **Unknown**. If categories exceed the total by more than $0.01, omit Unknown and keep Pi or message totals authoritative. Do not display a negative remainder.

The projection operates on a complete snapshot, including the optional streaming message. Replayed messages do not double-count because the PWA recalculates from state instead of adding event deltas.

#### Session total and breakdown

`get_session_meta` remains the PWA’s carrier. Its additive `usageBreakdown` is optional for older servers and contains the exact `PimoteUsageBreakdown` shape above. The server fills:

- `lifetimeCostUsd` from `session.getSessionStats().cost`.
- `usageBreakdown.tokens` from `SessionStats.tokens`.
- `usageBreakdown.cost` from the category reducer over `sessionManager.getEntries()`.

The reducer follows Pi’s usage inclusion policy: assistant messages, tool results, compactions, branch summaries, and other usage entries. `getEntries()` includes compacted history and alternate branches. The client compares known category dollars with `lifetimeCostUsd`. Differences of $0.01 or less count as rounding noise. A larger positive remainder appears as Unknown. If categories exceed the total by more than $0.01, omit Unknown and keep Pi’s scalar total authoritative. The existing `get_session_stats` command remains unchanged. Existing metadata requests on session open, agent end, and compaction end refresh the total; partial streaming snapshots do not change the session total.

#### Partial usage after abort

If Pi emits partial usage but the terminal aborted or errored message has no usable usage, retain the last positive partial amount in the active PWA transcript. Keep it as a client-only override. A full resync or reload can lose this fallback, and Pi’s session total can omit it. Final usage stored by Pi remains available after reload.

#### Client row access and cost disclosure projection

`SessionRegistry.getAssistantRowUsage(sessionId: string, messageIndex: number): AssistantRowUsage | null` exposes a finalized transcript row's summary. It incorporates the active-view-only terminal partial override without mutating the terminal wire message. Full resync discards overrides. Persisted final usage remains available after reload.

`client/src/lib/cost-disclosure.ts` defines `summarizeCostDisclosure(totalCostUsd: number | null | undefined, breakdown?: PimoteUsageBreakdown): CostDisclosure | null`. `CostDisclosure` contains `label: string`, `unknownCostUsd: number | null`, and `inconsistent: boolean`. Invalid or nonpositive totals return null. Missing breakdowns keep valid totals visible without inventing Unknown. Category differences within one cent return no Unknown and no inconsistency. Larger positive remainders return Unknown. Larger overages mark inconsistency without changing the total.

#### Cost disclosure interaction

The cost trigger is a real button with an accessible name and expanded state. Click, tap, Enter, and Space open its popover. Escape, the close control, and an outside click close it. One popover opens at a time.

The transcript trigger shows only the muted value: `<$0.01` below one cent, `$X.XX` at one cent or more. Hide zero, negative, missing, and non-finite totals. Place it left of the bot icon on desktop and right on narrow PWA layouts. Place a valid cost beside the compact “interrupted” row when no bot icon renders. The popover shows token counts where available and four-decimal cost categories. It shows a positive Unknown remainder only when that remainder exceeds $0.01.

The session trigger uses the same popover in the desktop status bar and mobile session settings. It shows the full Pi total and aggregate categories. There is no separate Tools category. Pi calculates the costs from provider usage and configured model prices; the UI does not present them as provider invoice amounts.

### Remove the forecast

Remove `nextRoundtripCostUsd` and its cache-read estimate from the server calculation, `SessionMeta`, client session state, cost formatter, desktop status bar, mobile session settings, tests, and cost smoke. Keep actual cache-read and cache-write usage and costs in message and session breakdowns.

### Technology Choices

**Use Bits UI Popover, already installed.** The mock uses a click/tap disclosure anchored to the number. Bits UI provides the existing primitive and avoids a new dependency. A Dialog would make a small breakdown modal and interrupt chat. A custom Svelte overlay would require Pimote to own positioning, dismissal, and keyboard behavior.

### Interaction Mocks

- `docs/mocks/per-assistant-turn-cost/index.html` — Approved desktop and narrow-layout cost triggers, session settings disclosure, category breakdowns, and interrupted-row cost.

### DR Supersessions

- **DR-028** (Server-side idempotent cost recompute over the session branch) — superseded because the product now uses Pi’s built-in whole-session accounting, including tool results, compactions, branch summaries, usage entries, compacted history, and alternate branches. New decision: `SessionStats.cost` is authoritative. Pimote adds only the category rollup needed for the tooltip. The idempotent recompute rationale remains because Pi calculates stats from persisted entries.

## Tests

**Pre-test-write commit:** `2f8e3045fb397c97b758dfcd0af5a72d845fcd98`

### Interface Files

- `shared/src/protocol.ts` — Defines serializable usage, breakdown, row-summary, streaming, and metadata shapes.
- `server/src/session-usage.ts` — Defines the session usage projection seam over persisted Pi entries.
- `client/src/lib/assistant-row-usage.ts` — Defines the assistant-row usage projection seam over transcript snapshots.
- `client/src/lib/stores/session-registry.svelte.ts` — Exposes row usage with client-only terminal fallback and retains streaming/final usage state.
- `client/src/lib/cost-disclosure.ts` — Defines total visibility, formatting, and category mismatch projection.
- `server/src/message-mapper.ts` and `server/src/event-buffer.ts` — Existing public mapping and live/replay boundaries.
- `server/src/ws-handler.ts` — Existing metadata command boundary.

### Test Files

- `server/src/session-usage.test.ts` — Covers session token authority and category-cost aggregation.
- `client/src/lib/assistant-row-usage.test.ts` — Covers assistant and matching tool-result usage aggregation.
- `server/src/message-usage.test.ts` — Covers usage mapping, persisted context, valid partial snapshots, final delivery, and replay.
- `server/src/ws-handler.test.ts` — Covers authoritative Pi metadata totals, category costs, and forecast absence.
- `client/src/lib/stores/session-usage.test.ts` — Covers replacement, final replay/resync/reload, in-flight resync, terminal fallback, metadata storage, and forecast absence.
- `client/src/lib/cost-disclosure.test.ts` — Covers numeric formatting, visibility, missing breakdowns, rounding tolerance, Unknown, and inconsistent overages.

### Behaviors Covered

#### Server session usage projection

- Preserve Pi's session token totals while aggregating input, output, cache-read, and cache-write dollars from assistant, tool-result, compaction, branch-summary, and usage entries.
- Ignore entries without usage-bearing model work.
- Return zero category costs for an empty persisted history.

#### Assistant-row usage projection

- Return an assistant response's own usage as the row breakdown.
- Add every matching tool-result usage and exclude unrelated or usage-less tool results.
- Keep multiple assistant rows separate when projecting a later response.
- Accept a streaming usage snapshot without adding subset fields twice.
- Return no row usage when the snapshot and matching tool results contain no usage.

#### Wire, state, and disclosure boundaries

- Preserve assistant and tool-result usage and tool-call correlation through mapping and persisted context.
- Forward finite, nonnegative partial usage, omit invalid snapshots, and preserve final usage through replay.
- Replace snapshots with final usage. Preserve final usage across resync and reload.
- Keep aborted/errored partial-only fallback in the active view without mutating terminal wire data. Discard it on full resync and reload.
- Restore in-flight usage from full resync.
- Use Pi's scalar session total and token counts with persisted category dollars. Partial snapshots do not change session totals.
- Remove forecast output and client state while retaining actual cache costs.
- Hide invalid/nonpositive totals. Format positive totals below one cent as `<$0.01` and larger totals to two decimals.
- Ignore category differences within one cent. Show larger positive Unknown remainders and flag larger overages without negative Unknown.
- Keep older-server totals visible when no breakdown exists.

#### Manual validation

Popover click/tap, keyboard accessibility, one-open-at-a-time behavior, responsive placement, interrupted-row placement, and status/settings integration remain in the default manual-testing phase. The approved interaction mock defines these expectations.

**Review status:** approved

## Steps

**Pre-implementation commit:** `cbfd1e9881dcfa8f79a41ca27226158c53aeb4e0`

### Step 1: Complete session usage projection

Implement `projectSessionUsage(entries, stats)` in `server/src/session-usage.ts` behind its existing interface. Copy token totals from `stats.tokens`. Aggregate only input, output, cache-read, and cache-write dollars from Pi's usage-bearing entry types: assistant messages, tool results, compactions, branch summaries, and usage entries. Ignore other entries and missing usage. Return zero category dollars for empty history. Do not calculate a scalar total or add subset token categories.

**Verify:** `server/src/session-usage.test.ts` passes, including the authoritative token totals and all five usage-bearing entry types.
**Status:** done

### Step 2: Preserve usage across server delivery

In `server/src/message-mapper.ts`, adapt Pi's real `Usage` type to `PimoteUsage`. Preserve assistant and tool-result usage, including optional subset fields. Keep tool-result correlation in the existing `tool_result.toolCallId` block. Other roles omit usage. Let `mapAgentMessages` and `mapContextEntries` retain usage through their existing calls to `mapAgentMessage`.

In `server/src/event-buffer.ts`, attach the current assistant message's cumulative usage to `message_start` and `message_update`. Forward only snapshots with finite, nonnegative token and cost fields. Keep validation at the SDK mapping seam and reuse it for streaming snapshots. Do not filter by provider. Preserve mapped final usage in `message_end` and buffered replay. Keep terminal abort/error messages intact when applying the existing empty-content fallback.

In `server/src/ws-handler.ts`, update `makeFullResyncEvent` to map the in-flight SDK message's usage even when its content is empty. Preserve the existing running-tool and context-entry behavior.

**Verify:** `server/src/message-usage.test.ts` passes. Existing mapper, event-buffer, and mid-run resync coverage retains its current behavior.
**Status:** done

### Step 3: Use Pi session totals and remove server forecast

In `server/src/ws-handler.ts`, replace the `sumLifetimeCostUsd` import with `projectSessionUsage`. In `get_session_meta`, read `session.getSessionStats()` and `session.sessionManager.getEntries()`. Set `lifetimeCostUsd` to `stats.cost` and `usageBreakdown` to `projectSessionUsage(entries, stats)`. Keep cached git-branch and context-usage handling. Leave `get_session_stats` unchanged.

Remove the context cache-read forecast calculation and output. Remove `nextRoundtripCostUsd` from `SessionMeta` in `shared/src/protocol.ts`. Keep the usage interfaces already committed there. Delete `server/src/session-cost.ts` and its superseded `server/src/session-cost.test.ts` coverage.

**Verify:** The `get_session_meta` cases in `server/src/ws-handler.test.ts` pass. Metadata keeps Pi's scalar total when category sums differ and never returns the forecast field.
**Status:** done

### Step 4: Implement row and disclosure projections

Implement `summarizeAssistantRowUsage(assistant, messages)` in `client/src/lib/assistant-row-usage.ts`. Correlate tool-result usage with `tool_call` IDs in the supplied assistant snapshot. Sum the assistant's usage and every matching tool result, including multiple results for one ID. Exclude unrelated and usage-less tool results. Return `null` when no contributor has usage. Keep each assistant response separate. Sum `cost.total` independently from categories and do not count subset tokens twice.

Implement `summarizeCostDisclosure(totalCostUsd, breakdown)` in `client/src/lib/cost-disclosure.ts`. Hide invalid and nonpositive totals. Use `<$0.01` below one cent and two decimals otherwise. Compare categories with the authoritative total using the one-cent tolerance, including floating-point rounding at that threshold. Return positive Unknown only above the tolerance. Mark larger category overages inconsistent without changing the total. Missing breakdowns do not invent Unknown.

Remove `formatCombinedCost` from `client/src/lib/session-summary.ts` and remove its obsolete coverage from `client/src/lib/session-summary.test.ts`. Retain `formatSessionCost` and its coverage only if a remaining caller needs it. Use the disclosure projection for the new cost UI.

**Verify:** `client/src/lib/assistant-row-usage.test.ts` and `client/src/lib/cost-disclosure.test.ts` pass without changes to their approved expectations.
**Status:** done

### Step 5: Retain usage in session state

In `client/src/lib/stores/session-registry.svelte.ts`, replace `nextRoundtripCostUsd` with optional `usageBreakdown` in `PerSessionState`, state initialization, and `updateMeta`. Keep session totals independent of partial message updates. Remove forecast fields from the existing `client/src/lib/stores/session-registry.test.ts` fixtures.

Store `message_start.usage` in `streamingMessage`. Replace that snapshot when `message_update` supplies usage. Preserve final `message_end.message.usage` without adding partial snapshots. Keep the existing full-resync spread that restores in-flight usage.

Implement the existing `getAssistantRowUsage(sessionId, messageIndex)` interface through the pure row projection. Retain the last positive partial usage as a client-only override when an aborted or errored terminal assistant message has no usable final usage. Associate overrides with stable message keys, not indices that optimistic insertion can move. Apply overrides only during row projection. Do not mutate terminal wire messages. Clear overrides when full resync rebuilds session state and when the session is removed. Final usable usage takes precedence.

**Verify:** `client/src/lib/stores/session-usage.test.ts` passes. Existing session-registry coverage retains optimistic-message reconciliation and resync behavior. Approved tests remain unchanged.
**Status:** done

### Step 6: Build the reusable cost popover

Create `client/src/lib/components/ui/popover/` wrappers and their `index.ts` exports using the existing Bits UI dependency. Follow the local dialog and dropdown-menu wrapper patterns for props, refs, classes, portals, and exports.

Create `client/src/lib/components/CostBreakdownPopover.svelte`. Accept the authoritative total, optional `PimoteUsageBreakdown`, and an accessible context label. Use `summarizeCostDisclosure` for visibility, trigger text, Unknown, and inconsistency. Render a muted numeric button and a category view with available token counts and four-decimal category dollars. Show no Tools category or negative Unknown. Keep valid older-server totals usable without a breakdown. Explain Pi's configured-price basis without claiming invoice accuracy.

Use Bits UI for positioning, expanded state, keyboard activation, focus handling, Escape, and outside dismissal. Include an accessible close control. Coordinate open state within the existing client UI so opening any cost disclosure closes the previous one. Keep this state separate from usage accounting.

**Verify:** Against `docs/mocks/per-assistant-turn-cost/index.html`, the default manual-testing phase confirms click, tap, Enter, Space, Escape, close, outside dismissal, and one-open-at-a-time behavior.
**Status:** done

### Step 7: Integrate transcript and session disclosures

In `client/src/lib/components/MessageList.svelte`, retain each finalized message's original transcript index in display entries. Derive finalized assistant row summaries through `sessionRegistry.getAssistantRowUsage`. Derive streaming summaries from the current streaming snapshot and finalized transcript through `summarizeAssistantRowUsage`. Pass the summary to `client/src/lib/components/Message.svelte` without changing message identity, tool rendering, or fork targets.

In `Message.svelte`, add the cost disclosure to assistant rows only. Place its number left of the bot icon on desktop and right on narrow layouts. Add it beside the compact interrupted indicator when the bot icon is absent. Keep one cost per assistant message, not per content block. Cost remains visible for positive terminal error or abort usage.

In `client/src/lib/components/StatusBar.svelte` and `client/src/lib/components/SessionSettingsDialog.svelte`, replace `formatCombinedCost` and static cost text with the reusable popover. Pass the session's `lifetimeCostUsd` and optional `usageBreakdown`. Keep the full Pi total separate from transcript projections.

**Verify:** The default manual-testing phase confirms desktop and narrow-layout placement, streaming updates, nested tool correlation, interrupted-row costs, status-bar disclosure, and mobile session settings against the approved mock. Existing MessageList and StatusBar coverage retains its behavior.
**Status:** done

### Step 8: Update the cost smoke and verify integration

Update `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs` to exercise Pi's complete-session total and category breakdowns. Replace static span/title selectors with accessible cost-button and popover selectors. Extend persisted fixtures with matching nested tool usage, category dollars, compaction, branch-summary, and usage entries. Check separate assistant rows, authoritative session totals, four cost categories, Unknown, and hidden zero spend.

Extend the smoke's live-event scenarios for replacement of partial snapshots, terminal partial-only fallback, final replay, in-flight full resync, and reload. Verify that full resync or reload drops transient fallback but preserves persisted final usage. Remove forecast expectations while retaining actual cache-read and cache-write checks.

Run the approved feature test files through each workspace's Vitest command, then run `npm run check`. Run the updated smoke and complete the default manual-testing phase for the interaction checks. Do not alter approved feature tests to accommodate implementation failures. Keep native Android files unchanged.

**Verify:** All approved feature tests pass, `npm run check` succeeds, and the updated cost smoke and manual interaction checks pass. Production code contains no `nextRoundtripCostUsd`, `formatCombinedCost`, or `sumLifetimeCostUsd` references.
**Status:** done
