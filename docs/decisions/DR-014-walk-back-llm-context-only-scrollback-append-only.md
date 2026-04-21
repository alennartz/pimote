# DR-014: Walk-back is LLM-context-only; persisted scrollback stays append-only with custom-entry interrupt markers

## Status

Accepted

## Context

Speechmux emits `rollback{heard_text}` on barge-in — a **content-precision** cutoff naming the delivered prefix the user actually heard, not a character offset. The voice extension must ensure the next LLM turn sees only what the user heard, so the model doesn't apologise for or reference content the user never received.

Two facts constrain the implementation, verified by reading `pi-agent-core/agent.js` and `pi-coding-agent/agent-session.js`:

1. Mid-stream `session.abort()` causes pi-agent-core to **discard** `agent.state.streamingMessage`. `message_end` never fires, so `sessionManager.appendMessage` is **not** called — **the session JSONL has no entry for the interrupted turn.**
2. pi-agent-core's `handleRunFailure` pushes a synthetic assistant with `content: [{type:"text", text:""}]` and `stopReason:"aborted"` into `agent.state.messages` (in-memory only).

Pi's persisted-scrollback contract is append-only by design.

The brainstorm originally said "the PWA scrollback will show the full streamed assistant text — including text the user never heard." That turned out to be false once pi's abort semantics were read from source.

## Decision

**Walk-back is applied to the LLM context only, on the next `context` hook invocation. Persisted scrollback remains append-only, and interrupts are recorded as `pimote:voice:interrupt` custom-message entries.**

Mechanism:

- The extension runs a `message_update` subscriber that continuously captures the in-flight streaming assistant content, so on abort it still holds the pre-abort snapshot (pi discards it).
- On speechmux `abort` / `rollback`, the extension calls `session.abort()`, sets a `heardText` watermark, and appends `appendCustomMessageEntry("pimote:voice:interrupt", { heard_text, kind: "abort" | "rollback" }, false)`.
- On the next LLM call, the `context` hook runs the walk-back surgery contract: strip pi's synthetic empty-text aborted assistant, then walk captured `speak` tool-use blocks and truncate the first block that crosses the `heardText` boundary, dropping everything after (including paired `tool_result` blocks and non-`speak` blocks past the cutoff). Clear watermark + captured after applying.

**Consequence accepted for v1: interrupted turns leave no assistant entry in the persisted scrollback.** The `pimote:voice:interrupt` marker records that _something_ was said and cut off; the actual text is not persisted.

Rejected alternatives:

- **Append a reconstructed assistant entry to the scrollback on abort.** Additive change, doesn't touch the v1 seam, but not required for LLM correctness. Deferred — if later we want "record of what was attempted" visible to users, the extension calls `appendMessage(reconstructed)` on abort.
- **Cross-entry walk-back** (user barges in across the boundary of a completed earlier turn). Out of scope for v1. The correct future primitive is `branch(fromId)` (moves the leaf pointer, records nothing) — **not** `branchWithSummary`, which would reinject the unheard continuation into the next turn's context. Additive; doesn't touch the v1 seam.
- **Let the LLM see the full unheard text** (rejected — the whole point is character-precision cutoff so the model doesn't reference content the user never heard).
- **Pi-SDK change to persist aborted streaming messages** — upstream work, not blocking v1. If/when it lands, the scrollback-vs-context fidelity split narrows naturally.

## Consequences

- Scrollback and LLM context are legitimately **different views**: scrollback records completed turns only (plus interrupt markers); LLM context is the subset the user actually heard. We do not try to unify them in v1.
- Multiple interrupts without an intervening completed turn collapse — only the most recent interrupted turn is reconstructed. Earlier interrupts lose their captured speak content from LLM context, but the persisted `pimote:voice:interrupt` entries preserve the fact that interrupts occurred.
- The walk-back surgery contract has four steps (strip synthetic aborted → early-exit on fully-unheard abort → walk captured blocks truncating at the boundary → append reconstructed with `stopReason: "aborted"`). Idempotent: if the hook runs without a new rollback, step 1 alone applies.
- The extension depends on `ExtensionContext.abort()` and `message_update` events — both are stable pi-SDK surfaces (`@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`). No pi-SDK changes required for v1.
