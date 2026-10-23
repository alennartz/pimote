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
