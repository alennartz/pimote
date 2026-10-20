# DR-073: Tool results follow pi's channel discipline

## Status

Accepted

## Context

Pimote's `jsonToolResult` idiom put one identical payload into all three channels of pi's `AgentToolResult`: model-facing `content` (JSON text), `details`, and `structuredContent`. Pi's contract assigns each channel a single audience — `content` for the model, `structuredContent` for programmatic callers (codemode scripts resolve to it when an `outputSchema` is declared), `details` for renderer/state metadata ("for rendering or state reconstruction"; pi's own tools populate it only with execution metadata, e.g. bash's truncation facts, or leave it undefined).

The duplication had two costs. The spill guard (DR-071) truncates the list tools' rows, and because the payload fanned out to every channel, the truncation hit codemode scripts and the pimote client too — scripts got a prefix plus a spill-file pointer instead of the data, diverging from pi's MCP behavior ("Codemode scripts receive the complete result"). And `details` carried a payload copy, which pi reserves for metadata — doubling transcript storage for large results and blurring the channels.

## Decision

One audience per channel, for every pimote tool:

- `content` — the model-facing view. Data tools bound it with the spill guard; the inline prefix plus the `spill` pointer live here.
- `structuredContent` — the complete, outputSchema-valid payload. Never truncated. Codemode scripts never need the spill file.
- `details` — renderer/state metadata only (list tools: `totalRows`, `inlineRows`, plus the spill pointer when the guard truncated; present on every list call, since the counts help a renderer even under budget). Undefined for tools with none. Never a copy of the payload.

`jsonToolResult` gained optional `modelView`/`details` overrides; the ten small action tools keep the single-payload call, where the channels legitimately coincide.

Rejected alternatives: `details` = full rows so the client's generic renderer shows typed data with no client work — rejected because it re-introduces the payload copy pi reserves for metadata and doubles transcript size; pi's built-in `truncateHead`/`truncateTail` for the model view — rejected because they are line-oriented text choppers and would destroy DR-071's row-aligned, jq-able JSONL spill.

## Consequences

Codemode scripts receive complete rows and never touch the spill file. The pimote client renders `content` text for pimote tools (compact JSON, not the pretty typed view) — accepted; the spill metadata in `details` keeps the truncation visible. Full rows persist in the session transcript via `structuredContent` — disk, not model context; the same trade pi's MCP bridge makes. The client's text-equals-details dedupe in `ToolCall.svelte` becomes near-dead code, kept for third-party tools that do duplicate.
