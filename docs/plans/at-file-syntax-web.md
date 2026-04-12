# Plan: @file syntax in web input with server autocomplete

## Context

We are adding TUI-style `@file` references to Pimote's web client so users can autocomplete file references in the input and have references resolved server-side before forwarding to the SDK. This work follows `docs/brainstorms/at-file-syntax-web.md` and must preserve current web interaction patterns (including optimistic user messages) while matching TUI semantics for `@` handling.

## Architecture

### Impacted Modules

#### Client

- **InputBar + autocomplete components** (`client/src/lib/components/InputBar.svelte`, `client/src/lib/components/CommandAutocomplete.svelte`)
  - Extend from slash-command-only autocomplete to an additional `@` reference mode.
  - Keep existing slash behavior unchanged while adding a separate request path for file ref suggestions.
  - Maintain desktop keyboard flow (arrows/tab/enter/esc) and mobile tap flow.

- **Connection + protocol consumers** (`client/src/lib/stores/connection.svelte.ts`, `client/src/lib/stores/session-registry.svelte.ts`)
  - Send new `complete_file_refs` command with prefix extracted client-side.
  - Keep optimistic message insertion/replacement behavior unchanged.
  - Consume server warning via existing extension-style notify event (`extension_ui_request` + `notify`) and show toast through existing `ExtensionStatus` flow.

- **Message rendering** (`client/src/lib/components/Message.svelte`)
  - Extend user-message rendering to support attachment metadata blocks while preserving current user bubble conventions.
  - Keep text body rendering style and placement consistent with current UI conventions.

#### Protocol

- **Wire contracts** (`shared/src/protocol.ts`)
  - Add a new command for file-reference autocomplete.
  - Extend `steer`/`follow_up` command shapes to carry attachments payloads (mirroring `prompt`) for parity.
  - Extend message content union to represent attachment metadata in user messages.

#### Server

- **Command handling/orchestration** (`server/src/ws-handler.ts`)
  - Handle new `complete_file_refs` command.
  - Route `prompt`, `steer`, and `follow_up` through shared file-reference expansion before SDK calls.
  - Preserve existing built-in command interceptions and lifecycle behavior.

- **Message mapping** (`server/src/message-mapper.ts`)
  - Map SDK user content blocks into attachment-aware wire content blocks while preserving current tool/thinking mapping.

- **Session/runtime integration** (`server/src/session-manager.ts`)
  - Reuse session cwd and connection-bound UI bridge for warning notifications.
  - No change to slot ownership/lifecycle model; attach/ref expansion stays stateless per request.

### New Modules

#### `server/src/file-references.ts`

Purpose: centralize all `@` reference behavior for server-side parity and reduce coupling in `ws-handler`.

Responsibilities:

- Parse `@` tokens from message text (including quoted paths with spaces and multiple refs in one message).
- Resolve token paths relative to session cwd with TUI-compatible path semantics (`./`, `../`, `~/`, absolute) and `@`-prefix normalization.
- Produce transformed text payload (`<file name="...">...</file>` blocks) and attachment payloads for media/document refs.
- Provide autocomplete suggestions for `@` prefixes using `fd` when available.
- Expose deterministic fallback behavior when `fd` is unavailable: return no suggestions and surface warning metadata for one-time client notification.

Proposed exported contracts (shape-level):

```ts
export interface FileRefAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface FileRefAutocompleteResult {
  items: FileRefAutocompleteItem[];
  fdAvailable: boolean;
  warning?: string;
}

export interface ExpandedFileRefs {
  text: string;
  images?: { type: 'image'; data: string; mimeType: string }[];
  attachments: Array<{
    path: string;
    name: string;
    mimeType?: string;
    kind: 'text' | 'image' | 'document';
  }>;
}

export async function completeFileRefs(input: { prefix: string; cwd: string; fdPath?: string }): Promise<FileRefAutocompleteResult>;

export async function expandFileRefs(input: { text: string; cwd: string }): Promise<ExpandedFileRefs>;
```

### Interfaces

#### 1) Client → Server autocomplete for `@` refs

New command:

```ts
interface CompleteFileRefsCommand {
  type: 'complete_file_refs';
  sessionId: string;
  prefix: string; // client-extracted token, includes leading @ or @"
}
```

Response payload:

```ts
interface CompleteFileRefsResponse {
  items: Array<{
    value: string; // token to insert into input
    label: string; // human-readable filename/dir label
    description?: string; // optional path context
  }> | null;
}
```

Behavioral contract:

- If prefix is not an `@` token, return `items: null`.
- If `fd` unavailable, return `items: []` and server emits one notify event to client session (toast path).
- Directory items keep trailing `/` semantics; file items are terminal insertions.

#### 2) Prompt/steer/follow-up send path with file-ref expansion

Existing commands become attachment-capable:

```ts
interface PromptCommand {
  type: 'prompt';
  sessionId: string;
  message: string;
  images?: string[]; // existing
}

interface SteerCommand {
  type: 'steer';
  sessionId: string;
  message: string;
  images?: string[]; // new
}

interface FollowUpCommand {
  type: 'follow_up';
  sessionId: string;
  message: string;
  images?: string[]; // new
}
```

Server orchestration contract:

1. Parse/expand `@` refs in `message`.
2. Merge expanded image/document attachments with incoming `images` payload (if any), preserving order semantics expected by SDK input blocks.
3. Call SDK with transformed text + merged attachments for all three modes.

Failure contract:

- Use TUI-style resolution semantics; unresolved/invalid refs fail the command with error response (same send-time strictness as TUI file resolution path).

#### 3) Server → Client message content for attachment UX

Extend wire content union for user messages:

```ts
type PimoteMessageContent =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; text?: string }
  | { type: 'tool_call'; ... }
  | { type: 'tool_result'; ... }
  | {
      type: 'attachment';
      name: string;
      path: string;
      kind: 'text' | 'image' | 'document';
      mimeType?: string;
    };
```

Mapping contract:

- User message content arrays received from SDK are transformed into text + attachment blocks for web rendering.
- Current mappings for assistant/tool/custom roles remain unchanged.

#### 4) Server warning transport via existing UI bridge channel

Reuse existing event channel (no new top-level protocol event):

```ts
{
  type: 'extension_ui_request',
  sessionId,
  method: 'notify',
  message: 'fd not found ... install guidance',
  notifyType: 'warning'
}
```

Behavioral contract:

- Emitted at most once per session/runtime when file-ref autocomplete is requested and `fd` is unavailable.
- Client shows toast via existing `ExtensionStatus` notify handler.

### Technology Choices

#### A) Reuse pi-tui internals directly vs local implementation

- **Option 1 (chosen): local Pimote implementation + `fd` usage**
  - Reimplement parsing/expansion/autocomplete orchestration in `server/src/file-references.ts`, using stable public dependencies and `fd` binary invocation semantics.
  - **Why chosen:** pi-tui and coding-agent internals for this flow are not reliably public APIs; direct dependency on internals is brittle under SDK upgrades.

- **Option 2: call pi-tui/coding-agent internal modules directly**
  - Lower initial code, but high break risk (exports and internal structure may change without compatibility guarantees).

- **Option 3: patch upstream SDK to export stable APIs first**
  - Best long-term abstraction, but blocks immediate feature delivery and introduces multi-repo coordination overhead.

#### B) `fd` missing behavior

- **Option 1 (chosen): no suggestions + warning toast**
  - Keeps behavior deterministic and simple.
  - Matches TUI's non-blocking degradation posture while keeping app usable.

- **Option 2: fallback filesystem listing**
  - More complexity and diverges from expected fuzzy behavior; harder to keep parity and performance.

#### C) Warning transport path

- **Option 1 (chosen): reuse extension notify bridge (`extension_ui_request` + `notify`)**
  - No protocol event expansion needed; integrates with existing client toast stack.

- **Option 2: add new server notice event**
  - Semantically cleaner but unnecessary protocol surface for this targeted warning class.
