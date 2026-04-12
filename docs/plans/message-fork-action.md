# Plan: Message-level fork action in chat

## Context

We are adding a message-level fork action to Pimote’s web chat so users can fork directly from a user message via the message icon affordance, instead of using slash-command flow. This follows `docs/brainstorms/message-fork-action.md` and should match TUI fork semantics (fork user messages, switch immediately, restore selected prompt text) while adding a web-only draft collision prompt.

## Architecture

### Impacted Modules

#### Client

- **Message rendering + per-message actions** (`client/src/lib/components/Message.svelte`)
  - Add a user-message action menu opened by clicking the user icon.
  - Add a fork action button in that menu (user messages only).
  - Keep assistant message action menu unchanged (TTS only).

- **Message list fork orchestration** (`client/src/lib/components/MessageList.svelte`)
  - Own fork execution flow because it already coordinates session-level actions (e.g., abort/dequeue) and has access to viewed session context.
  - Add local dialog state for non-empty draft conflict resolution with choices: Replace, Append, Prepend, Ignore.
  - Reuse existing shadcn dialog primitives/components for UI consistency.

- **Input synchronization path** (`client/src/lib/stores/input-bar.svelte.ts`, `client/src/lib/components/InputBar.svelte`)
  - Continue using `setEditorText(sessionId, text)` as the canonical cross-component input injection mechanism.
  - Preserve per-session draft behavior via SessionRegistry and existing input hydration effects.

#### Protocol

- **Wire command + message shape** (`shared/src/protocol.ts`)
  - Add a new session-scoped `fork` command with `entryId`.
  - Add optional `entryId` on `PimoteAgentMessage` so message UI can target exact session entries.

#### Server

- **Message mapping** (`server/src/message-mapper.ts`)
  - Preserve SDK message IDs in mapped wire messages as `entryId`.

- **Session command handling** (`server/src/ws-handler.ts`)
  - Implement `fork` command using `slot.runtime.fork(entryId)`.
  - Reuse existing session reset/session replacement handling (`handleSessionReset`) to keep fork lifecycle behavior consistent with runtime-driven replacement.
  - Return `selectedText` and `cancelled` from command response so client can apply input policy.

### Interfaces

#### Protocol additions

```ts
// shared/src/protocol.ts

export interface ForkCommand extends CommandBase {
  type: 'fork';
  entryId: string;
}

export interface PimoteAgentMessage {
  role: string;
  content: PimoteMessageContent[];
  entryId?: string;
  customType?: string;
  display?: boolean;
  [key: string]: unknown;
}

export type PimoteCommand =
  | ...
  | ForkCommand
  | ...;
```

#### Server command contract

```ts
// request
{ type: 'fork', sessionId: string, entryId: string }

// response (success)
{ selectedText?: string, cancelled: boolean }
```

Semantics:

- `cancelled: true` means fork was cancelled upstream (e.g., extension hook) and client should not apply input changes.
- `selectedText` is the selected user-message text from runtime fork flow, aligned with TUI behavior.

#### Client fork flow contract

Fork action event payload from `Message` to parent orchestration:

```ts
{
  entryId: string;
}
```

Parent (`MessageList`) flow:

1. Validate viewed session + entryId.
2. Send `fork` command.
3. If cancelled: stop.
4. After session replacement/resync, apply draft policy:
   - empty current draft: replace with `selectedText` (if present)
   - non-empty draft: prompt Replace / Append / Prepend / Ignore
5. Use `setEditorText(newSessionId, nextText)` for non-Ignore choices.

### Technology Choices

No new dependencies are required. Reuse existing shadcn dialog and existing connection/session/input stores.

Alternatives considered:

- **Reuse extension UI queue for the draft-choice prompt**
  - Rejected: that queue is for server-driven extension dialogs (`extension_ui_request` lifecycle). Fork draft-choice is a local client decision and should not require synthetic queue requests or protocol coupling.

- **Avoid protocol changes; infer fork target from message text/time**
  - Rejected: brittle and ambiguous. Exact `entryId` targeting is required for deterministic fork behavior.

### DR Supersessions

None.

## Tests

**Pre-test-write commit:** `1468103a5f0eea151fc1c54c971afaf4da5726a1`

### Interface Files

- `shared/src/protocol.ts` — Added `ForkCommand` interface, added `entryId?: string` to `PimoteAgentMessage`, added `ForkCommand` to `PimoteCommand` union
- `server/src/message-mapper.ts` — Added `id?: string` to `SdkMessage` interface, pass through SDK message `id` as `entryId` on all mapped message types
- `server/src/ws-handler.ts` — Added `'fork'` to session command routing, added stub fork handler with `entryId` validation

### Test Files

- `server/src/message-mapper.test.ts` — Tests for entryId pass-through from SDK messages to PimoteAgentMessage across all message roles
- `server/src/ws-handler.test.ts` — Tests for fork command validation, runtime invocation, response shape, session replacement lifecycle, and cancellation handling

### Behaviors Covered

#### Message Mapper (entryId pass-through)

- Preserves SDK message `id` as `entryId` for user messages
- Preserves SDK message `id` as `entryId` for assistant messages
- Omits `entryId` when SDK message has no `id`
- Preserves `entryId` for custom messages
- Preserves `entryId` for tool result messages
- Preserves `entryId` across bulk `mapAgentMessages` calls

#### Fork Command (ws-handler)

- Rejects fork when `sessionId` is missing
- Rejects fork when session does not exist in memory
- Rejects fork when `entryId` is missing
- Calls `runtime.fork(entryId)` and returns `{ selectedText, cancelled }` from the result
- Returns `{ cancelled: true }` when fork is cancelled, without triggering session reset events
- Triggers `session_replaced` event when fork changes the session ID
- Omits `selectedText` from response when runtime does not provide it
