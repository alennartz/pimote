# Brainstorm: Per-assistant-message cost visualization

## The idea

Show each assistant message’s Pi-calculated cost in the PWA transcript. Also keep one whole-session cost in the status UI, with clickable breakdowns for both values. This is the final feature pull planned for 0.15.

## Key decisions

### Cost scope

- One **assistant message row** is one Pi assistant message rendered as a bot-icon row. It is not a complete agent run. One provider response can contain several text, thinking, and tool-call blocks, but Pi reports one `Usage` structure for that response. Do not allocate its cost among those blocks.
- A row’s total includes the assistant response’s `usage.cost.total` and nested tool-model usage from tool results whose `toolCallId` matches a tool call in that row. A later assistant response is a new row with its own usage.
- Nested tool usage has the same token and cost categories as assistant usage. Fold it into the row’s input, output, cache-read, and cache-write categories. Do not create a separate Tools category.
- Ordinary tool output has no separate usage record. When a later assistant request sends that output to the model, its tokens appear in that request’s input, cache-read, or cache-write usage. Pi does not attribute those tokens to one specific tool result.
- Show reported positive cost as soon as reliable usage arrives. Use partial usage only when Pi exposes it. Otherwise, update when the assistant response or tool result completes. Replace partial totals with final totals; do not add snapshots together or estimate cost.
- Keep reported cost on aborted and errored assistant messages. Show cost beside the compact “interrupted” row when that row has no bot icon. Retries need no special grouping or presentation.
- If an aborted stream has no final Pi usage, keep its last reported partial cost in the active PWA transcript only. Do not persist this fallback. A full resync or reload can lose it, and Pi’s session total can omit it. The partial value is best-known data, not a final usage record.

### Whole-session total and breakdown

- Use Pi’s `AgentSession.getSessionStats().cost` as the authoritative whole-session total. Pi counts assistant messages, tool results, compactions, branch summaries, other usage entries, compacted history, and alternate branches. Keep one total; do not split it by source.
- Pi’s session stats expose cumulative token counts by category and one cumulative dollar total. The cost tooltip needs a category rollup from the same usage-bearing entries: input, output, cache read, and cache write. Keep Pi’s scalar cost as the total.
- If category costs fall short of Pi’s total by more than $0.01, show the positive remainder as **Unknown**. Treat an overage greater than $0.01 as inconsistent data, not a negative Unknown value. Ignore differences of one cent or less.
- Pi calculates these costs from provider usage and the selected model’s configured prices. This is Pi’s cost figure, not a verified provider invoice amount.

### UI and scope

- Show only the muted cost number in the transcript. Format positive values below one cent as `<$0.01`; format values of one cent or more with two decimals. Hide zero, negative, missing, and non-finite totals.
- Place row cost left of the bot icon on desktop and right of it on narrow PWA layouts. If an empty aborted row has a cost, place it beside “interrupted.”
- Make both row and session cost numbers clickable. Open a touch- and keyboard-accessible breakdown popover with category costs and token counts where available. Keep the visible transcript label number-only.
- Keep the session total in the status UI and mobile session settings. Make each displayed total clickable.
- Do not change the native Android client.

### Remove the forecast, keep actual cache costs

Remove the next-round-trip cache-read forecast end to end: calculation, protocol field, session state, formatter, status and settings displays, tests, and smoke coverage. Keep provider-reported cache-read and cache-write usage and cost in per-message and session totals.

## Direction

Forward the Pi usage data needed for per-message rows and session breakdowns over the existing server–PWA protocol. Keep Pi’s session total authoritative. Add only the category rollup needed for the tooltip; it does not replace or recompute the whole-session total. Preserve final usage across live delivery, replay, resync, reconnect, and reload. Partial-only aborted snapshots stay transient in the active PWA view. Ship in the PWA only.

## Open questions

### Sharp (→ architecting)

- Which providers expose reliable partial `Usage` during streaming? Trace Pi’s event path and forward cumulative snapshots only when they contain usable data. Otherwise, show the exact total at message completion.
- Map full or sufficient usage for assistant and tool-result messages across live events, replay, context resync, and persisted history. Preserve the `toolCallId` association and avoid double-counting partial/final usage.
- Build the session category rollup over the same entry types that Pi counts. Compare its categories with `SessionStats.cost`; define the mismatch tolerance and behavior when categories exceed the total.
- Remove every forecast-only field and calculation without removing actual cache usage. Update desktop, narrow PWA, error/abort, reload, and manual-smoke coverage.
- Keep the additive wire change compatible without changing Android. Provide accessible click/tap popovers for both cost values.

### Fog

None flagged.
