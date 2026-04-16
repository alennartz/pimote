# Edit Tool Visualization

## The Idea

Change how the `edit` tool call is visualized in the pimote client. Currently, edit tool calls are displayed identically to every other tool call: a collapsible header with the file path, and when expanded, raw JSON args and a raw result. This makes it hard to see what actually changed.

## Key Decisions

### Diff rendering via markdown code blocks

Render each edit's `oldText`/`newText` pair as a markdown ````diff` code block with `-` lines for old text and `+` lines for new text. This uses the existing rendering pipeline: TextBlock → streaming-markdown → highlight.js (which already has `diff` language registered and `.hljs-addition`/`.hljs-deletion` styles defined).

No line-level diff algorithm is needed. The naive approach (all oldText lines become `-`, all newText lines become `+`) is sufficient because the agent already keeps edits minimal and focused — the system prompt tells it to keep `oldText` as small as possible while being unique.

### Multiple edits as separate diff blocks

When an edit call contains multiple entries in its `edits[]` array, each edit gets its own separate ````diff` code block. This makes it clear where one replacement ends and another begins.

### Auto-expand while streaming, auto-collapse when done

Follow the ThinkingBlock pattern:

- Auto-expand when streaming starts (tool call args begin arriving)
- Stay expanded through tool execution
- Auto-collapse when the tool execution completes
- User can manually toggle at any time

### Server-side transform of streaming deltas

The critical insight: if we only generate the diff after args are fully parsed, the tool executes nearly instantly and the diff is visible for a fraction of a second before auto-collapse. The user never gets to read it.

To solve this, the server transforms `message_update` streaming deltas for edit tool calls. Instead of forwarding raw JSON character by character, the server incrementally parses the JSON structure and emits diff-formatted markdown as `oldText`/`newText` string values complete. This way the client sees the diff building up in real time through the existing TextBlock streaming-markdown renderer.

The edit args JSON structure is predictable (`{"path":"...","edits":[{"oldText":"...","newText":"..."},...]}`), making incremental extraction of string values feasible.

### Client generates diff for completed/restored state

After `message_end` replaces the streaming message, the tool call content has parsed `args` (the original JSON object), not the transformed streaming text. The client generates diff markdown from the parsed args for display in the completed state. This also handles restored sessions and reconnects where no streaming occurred.

### Only edit tool calls are affected

All other tool calls (read, write, bash, etc.) keep their current visualization. This is an edit-specific enhancement.

## Direction

Two coordinated changes:

1. **Server (event-buffer.ts / session-manager.ts area)**: Intercept `message_update` events for `edit` tool calls. Buffer incoming JSON deltas, incrementally parse to extract string values, and re-emit as diff-formatted markdown. The server needs to track per-tool-call parser state (which field are we inside, etc.).

2. **Client (ToolCall.svelte)**: Detect edit tool calls. Render content through TextBlock (for markdown/diff support with syntax highlighting) instead of the current raw JSON in StreamingCollapsible. Add ThinkingBlock-style auto-expand/collapse tied to the streaming + tool execution lifecycle. Generate diff markdown from parsed args for the completed state.

## Open Questions

- **Result section for completed edits**: Currently tool calls show an "Arguments" section and a "Result" section. The diff replaces Arguments. Should the Result still be shown (it's usually just a success confirmation), or hidden unless it's an error?
- **Error display**: When the edit tool returns an error (file not found, oldText not matched), how should the error be shown alongside the diff? The diff shows what was attempted; the error shows why it failed.
