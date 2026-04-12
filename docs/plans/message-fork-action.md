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

#### Client draft policy

```ts
// client/src/lib/draft-policy.ts

export type DraftChoice = 'replace' | 'append' | 'prepend' | 'ignore';

/**
 * Whether a fork with the given draft state needs a conflict prompt.
 * Returns true only when both currentDraft and selectedText are non-empty strings.
 */
export function needsDraftPrompt(currentDraft: string, selectedText: string | undefined): boolean;

/**
 * Compute the next editor text for a given draft choice.
 * Returns null for 'ignore' (draft remains unchanged).
 * For append/prepend, joins with a single newline separator.
 */
export function applyDraftChoice(currentDraft: string, selectedText: string, choice: DraftChoice): string | null;
```

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

- `client/src/lib/draft-policy.ts` — `DraftChoice` type, `needsDraftPrompt` function, `applyDraftChoice` function for client-side fork draft conflict resolution
- `shared/src/protocol.ts` — Added `ForkCommand` interface, added `entryId?: string` to `PimoteAgentMessage`, added `ForkCommand` to `PimoteCommand` union
- `server/src/message-mapper.ts` — Added `id?: string` to `SdkMessage` interface, pass through SDK message `id` as `entryId` on all mapped message types
- `server/src/ws-handler.ts` — Added `'fork'` to session command routing, added stub fork handler with `entryId` validation

### Test Files

- `client/src/lib/draft-policy.test.ts` — Tests for draft conflict detection and resolution across all choice types
- `server/src/message-mapper.test.ts` — Tests for entryId pass-through from SDK messages to PimoteAgentMessage across all message roles
- `server/src/ws-handler.test.ts` — Tests for fork command validation, runtime invocation, response shape, session replacement lifecycle, and cancellation handling

### Behaviors Covered

#### Draft Policy (client-side conflict resolution)

- Returns false (no prompt) when current draft is empty
- Returns false when selectedText is undefined
- Returns false when selectedText is empty string
- Returns true when both currentDraft and selectedText are non-empty
- Returns false when draft is whitespace-only
- Returns selectedText for replace choice
- Appends selectedText after current draft with newline separator
- Prepends selectedText before current draft with newline separator
- Returns null for ignore choice (draft unchanged)

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

**Review status:** approved

## Steps

**Pre-implementation commit:** `ca4bc9ecec0992551b1f3e6c6abba290da5ab1b2`

### Step 1: Implement `needsDraftPrompt` and `applyDraftChoice` in `client/src/lib/draft-policy.ts`

Replace the two stub functions with their real implementations:

- `needsDraftPrompt(currentDraft, selectedText)`: return `true` only when `currentDraft.trim().length > 0` **and** `selectedText` is a non-empty string. All other combinations return `false`.
- `applyDraftChoice(currentDraft, selectedText, choice)`: switch on `choice`:
  - `'replace'` → return `selectedText`
  - `'append'` → return `currentDraft + '\n' + selectedText`
  - `'prepend'` → return `selectedText + '\n' + currentDraft`
  - `'ignore'` → return `null`

These are pure functions with no dependencies. Remove the parameter underscores and the `throw` stubs.

**Verify:** `npx vitest run client/src/lib/draft-policy.test.ts` — all 10 tests pass.
**Status:** done

### Step 2: Implement the `fork` command handler in `server/src/ws-handler.ts`

In `handleSessionCommand`, replace the `case 'fork'` stub (`throw new Error('Not implemented: fork command')`) with real logic that follows the same pattern used by `navigate_tree` / `new_session`:

1. Keep the existing `entryId` validation that sends an error response.
2. Call `const result = await slot.runtime.fork(command.entryId)` (the runtime method already exists — see `createCommandContextActions`).
3. If `!result.cancelled`, call `await this.handleSessionReset(slot)` — this handles `rebuildSessionState`, `reKeySession`, `session_replaced` event emission, and sidebar broadcasts, identical to the `navigate_tree` non-cancelled path.
4. Build the response data: `{ cancelled: result.cancelled }`. If `result.selectedText !== undefined`, add `selectedText: result.selectedText`.
5. Call `this.sendResponse(id, true, data)`.

The key reference is the `navigate_tree` handler at the same level in the switch — fork follows the same await-runtime → conditional-handleSessionReset → build-data → sendResponse pattern, but without tree navigation lifecycle events.

**Verify:** `npx vitest run server/src/ws-handler.test.ts` — all fork command tests pass (validation errors, runtime invocation, cancellation, session replacement, selectedText omission).
**Status:** done

### Step 3: Add fork action to user message icon in `client/src/lib/components/Message.svelte`

Add a user-message action menu that opens when the user icon is clicked (mirroring the assistant icon's existing TTS menu pattern):

1. Accept a new prop `onfork`: `{ onfork?: (entryId: string) => void }`. The `entryId` comes from `message.entryId`.
2. For user messages (`message.role === 'user'`), make the `.user-icon` div a `<button>` when `message.entryId` is present. Add local state `userMenuOpen` (boolean).
3. When clicked, toggle `userMenuOpen`. Show a small menu (same visual pattern as `.tool-menu` on assistant messages) containing a single "Fork" button. Use the `GitFork` icon from `@lucide/svelte/icons/git-fork`.
4. The Fork button calls `onfork?.(message.entryId!)` and closes the menu.
5. When `message.entryId` is absent (shouldn't happen for real messages but defensive), render the icon as a plain `<div>` with no interactivity.
6. Style the user action menu consistently with the existing assistant `.tool-menu`.

**Verify:** The component compiles. User messages show a clickable icon that reveals a Fork button. Clicking Fork fires the `onfork` callback with the message's `entryId`. Manual visual check in browser.
**Status:** done

### Step 4: Wire fork orchestration in `client/src/lib/components/MessageList.svelte`

MessageList owns the fork execution flow because it already has access to `connection`, `sessionRegistry`, and `setEditorText`.

1. **Add a `handleFork(entryId: string)` function** that:
   a. Gets `session = sessionRegistry.viewed` — bail if null.
   b. Sends `{ type: 'fork', sessionId: session.sessionId, entryId }` via `connection.send()`.
   c. Reads the response: if `data.cancelled` is true, return.
   d. After session replacement (handled reactively by `session_replaced` event in session-registry), apply draft policy:
   - Read `currentDraft` from `sessionRegistry.viewed?.draftText ?? ''`.
   - Read `selectedText` from `data.selectedText`.
   - If `needsDraftPrompt(currentDraft, selectedText)` returns true, open a local dialog (Step 5) and await the user's `DraftChoice`.
   - Otherwise, if `selectedText` is present, directly call `setEditorText(sessionRegistry.viewedSessionId!, selectedText)`.
   - If the user chose a non-ignore option, compute `nextText = applyDraftChoice(currentDraft, selectedText, choice)` and if non-null, call `setEditorText(sessionRegistry.viewedSessionId!, nextText)`.

2. **Pass `handleFork` down** to `<Message>` as the `onfork` prop in the `{#each}` loop.

3. **Add local dialog state** for the draft conflict prompt (see Step 5).

Imports needed: `needsDraftPrompt`, `applyDraftChoice`, `DraftChoice` from `$lib/draft-policy.js`.

**Verify:** Clicking Fork on a user message sends the fork command, receives the response, and applies draft policy. When no conflict: editor text is set to selectedText. When conflict: dialog appears. Manual integration test in browser.
**Status:** done

### Step 5: Add draft conflict dialog in `client/src/lib/components/MessageList.svelte`

Add a local dialog for draft conflict resolution using existing shadcn dialog primitives (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` from `$lib/components/ui/dialog`).

1. **State:** `draftDialogOpen: boolean`, `draftDialogResolve: ((choice: DraftChoice) => void) | null`. Managed as component-local `$state()`.
2. **Helper function** `promptDraftChoice(): Promise<DraftChoice>` — sets `draftDialogOpen = true`, returns a promise resolved by `draftDialogResolve`.
3. **Dialog markup** — render inside the component template:
   - Title: "Draft conflict"
   - Description: "The editor already has text. How should the forked message be combined?"
   - Four buttons in the footer: Replace, Append, Prepend, Ignore. Each calls `draftDialogResolve?.('replace')` etc., then sets `draftDialogOpen = false`.
4. **Integration with Step 4:** when `needsDraftPrompt` returns true, call `const choice = await promptDraftChoice()` and continue with `applyDraftChoice`.

**Verify:** When forking a message while the editor has content, the dialog appears with four choices. Each choice correctly computes the resulting text. Ignore leaves the editor unchanged. Manual integration test in browser.
**Status:** done
