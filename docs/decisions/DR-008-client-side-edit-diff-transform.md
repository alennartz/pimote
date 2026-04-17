# DR-008: Client-side streaming JSON parsing for edit tool diff view

## Status

Accepted

## Context

The pimote client renders `edit` tool calls as progressively-built markdown ```diff blocks (one per `edits[]`entry) so the user can watch the edit take shape during streaming. Producing that diff markdown requires incrementally parsing the`edit` tool's args JSON (`{"path":"...","edits":[{"oldText":"...","newText":"..."}, ...]}`) out of the raw token-by-token stream pi emits — we need to see `oldText`/`newText` values as their characters arrive, not only once the JSON object closes.

The transform could live on either side of the WebSocket. The initial brainstorm proposed doing it on the server: intercept `message_update` events for `edit` tool calls, buffer the JSON deltas, and re-emit diff-formatted markdown over the wire. That would have kept the client rendering path trivial (just display streamed text) but required per-tool-call parser state on the server and a wire-format divergence for one specific tool.

## Decision

Do the incremental JSON-to-diff transform client-side, inside `ToolCall.svelte` via `createEditDiffStreamer()` (backed by `@streamparser/json`). The wire protocol is unchanged — edit tool calls continue to stream raw args JSON over `message_update` events exactly like every other tool. Only the `edit` branch of `ToolCall.svelte` re-parses that stream to build the diff markdown.

The reasoning is that the server and the client are staring at the same problem: the pi SDK hands the server token-by-token JSON, and the server hands the client token-by-token JSON. Moving the parser server-side doesn't make the streaming-JSON problem go away, it just relocates it — and pays for the relocation with a tool-specific wire shape, a new piece of per-session state on the server, and a second implementation path to maintain if new clients ever want raw args.

## Consequences

- The `edit`-tool visualization is fully contained in one client file pair (`edit-diff.ts` + `ToolCall.svelte`). Feature scope is localized; server, protocol, and `event-buffer.ts` are untouched.
- The wire format stays uniform across all tool calls — useful for replay, debugging, and any future non-pimote client that wants the raw JSON stream.
- Every client that wants the diff view has to ship the streaming-JSON parser (`@streamparser/json`, ~small). Today that's only the pimote PWA, so the cost is paid once.
- If a future requirement demands the _server_ to reason about edit contents (e.g., server-side diff summarization for notifications), this decision doesn't block it — a server-side parser can be added alongside without replacing the client-side one.
- Restored sessions / reconnects render the same diff via the pure `buildEditDiffMarkdown(args)` path, because the client still has the finalized args object. The streaming and finalized paths are required to produce byte-identical markdown so the handoff is invisible.
