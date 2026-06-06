# Plan: @file path autocomplete in web input

## Context

We are adding TUI-style `@` file-path autocomplete to Pimote's web client. When the user types `@` in the input, the client surfaces an `fd`-backed fuzzy list of files and directories under the session's working directory; picking one inserts the path token into the input. The literal `@path` text is then sent unchanged through the existing `prompt`/`steer`/`follow_up` commands — the agent reads referenced files with its own `read` tool.

This deliberately matches pi's **interactive TUI** `@` behavior, which is autocomplete-only:

- `@` completion shells out to `fd` and inserts the chosen path back into the editor (`@earendil-works/pi-tui` `CombinedAutocompleteProvider`).
- At submit, the raw `@path` text is passed to `session.prompt(text)`. `session.prompt` expands `/` commands, skills, and prompt templates, but **does not** expand `@` references — they reach the model as plain text.

It is **not** the CLI `pi @foo.png "…"` behavior (`processFileArguments`), which inlines text files as `<file>` blocks and attaches images. We are not building that. There is no server-side expansion, no `<file>` injection, no image/attachment materialization.

This supersedes the earlier draft of this plan, which targeted CLI-style server-side expansion. That scope is dropped.

## Architecture

### Impacted Modules

#### Client

- **InputBar** (`client/src/lib/components/InputBar.svelte`)
  - Today, autocomplete is hard-gated to text starting with `/` (slash commands) — there is no `@` detection.
  - Add a second trigger: detect an `@`-prefixed token immediately before the cursor (including `@"…"` quoted tokens that contain spaces), extract it as the completion prefix, and request file-ref suggestions.
  - Keep slash behavior unchanged. `@` and `/` are mutually exclusive per token; `@` can appear anywhere in the line, not just at the start.
  - On accept, insert the chosen path token: `@<path>` for unquoted, `@"<path>"` when the path contains spaces, with a trailing `/` for directories. After accepting a directory, keep the menu open so the user can drill in (matches TUI).
  - Preserve desktop keyboard flow (arrows / tab / enter / esc) and mobile tap flow — both already exist for slash mode and are reused.

- **CommandAutocomplete** (`client/src/lib/components/CommandAutocomplete.svelte`)
  - Already a generic dropdown that renders `AutocompleteResponseItem[]` and handles debounced fetching, stale-response discard, selection, and rendering.
  - Reused as-is for `@` results. The new request path lives in `InputBar`; the dropdown component does not need to know whether it is showing slash args or file refs.

No changes to `connection.svelte.ts`, `session-registry.svelte.ts`, `command-store.svelte.ts`, `Message.svelte`, optimistic-message handling, or any send path. The `@path` token is ordinary message text.

#### Protocol

- **Wire contract** (`shared/src/protocol.ts`)
  - Add a single `complete_file_refs` command (client → server).
  - Response reuses the existing `AutocompleteResponseItem` shape already used by the generic `complete_args` pipeline — no new item type.
  - No changes to `PromptCommand` / `SteerCommand` / `FollowUpCommand`, no `images` additions, no message-content-union changes.

#### Server

- **Command handling** (`server/src/ws-handler.ts`)
  - Add a `complete_file_refs` case that resolves the session's cwd (`ManagedSlot.folderPath`) and calls `completeFileRefs` from the new module, returning `AutocompleteResponseItem[]`.
  - No change to `prompt` / `steer` / `follow_up` handlers — they continue to forward `command.message` unchanged.

- **Session/runtime integration** (`server/src/session-manager.ts`)
  - Reuse `ManagedSlot.folderPath` as the cwd for resolution and the existing connection-bound UI bridge for the one-time fd-missing warning. No lifecycle changes.

### New Modules

#### `server/src/file-references.ts`

Purpose: encapsulate `fd`-backed file-path autocomplete so `ws-handler` stays thin.

Responsibilities:

- Parse the incoming `@` prefix into its path components, mirroring TUI semantics:
  - Strip the leading `@` (and surrounding quotes for `@"…"`).
  - Support `~/`, `/abs`, `./`, `../`, and bare relative paths resolved against the session cwd.
  - **Scope by splitting at the last `/`:** the segment up to and including the last `/` is the directory scope (resolved against the session cwd, or `~/`/absolute), and the trailing segment after the last `/` becomes the fd query pattern. A prefix ending in `/` therefore yields an empty query ("list contents of this directory"); a bare single-segment prefix (`@comp`) yields no scope and queries from the cwd.
  - We deliberately **do not** port the TUI's `statSync`-guarded fallback (where a multi-segment prefix whose directory doesn't exist falls back to a `--full-path` fuzzy search from the cwd). That branch is filesystem-coupled and obscure; pimote's narrowed scope doesn't need it.
- Invoke `fd` to walk the tree (fast, `.gitignore`-aware): `--type f --type d --hidden --follow --exclude .git --max-results <N>`. Because the query is always the post-scope trailing segment, it never contains a `/`, so `--full-path` is **not** used for scoped multi-segment queries. (`walkDirectoryWithFd`'s `--full-path`-when-query-contains-`/` guard may be retained defensively, but the scoping above means it does not fire in normal operation.)
- Map results to `AutocompleteResponseItem[]`: `value` is the token to insert (with `@` prefix, quoting when needed, trailing `/` for directories), `label` is the display path, `description` optional.
- Degrade deterministically when `fd` is unavailable: return `[]` and signal that a one-time warning should be shown.

Proposed exported contract (shape-level):

```ts
import type { AutocompleteResponseItem } from '@pimote/shared';

export interface CompleteFileRefsInput {
  prefix: string; // the @-token as typed, e.g. '@src/', '@"my dir/'
  cwd: string; // session working directory
  fdPath?: string;
}

export interface CompleteFileRefsResult {
  items: AutocompleteResponseItem[];
  fdAvailable: boolean;
}

export async function completeFileRefs(input: CompleteFileRefsInput): Promise<CompleteFileRefsResult>;
```

There is **no** `expandFileRefs` and no attachment/image handling in this module.

### Interfaces

#### 1) Client → Server: file-ref autocomplete

```ts
interface CompleteFileRefsCommand {
  type: 'complete_file_refs';
  sessionId: string;
  prefix: string; // client-extracted @-token, including leading @ (and opening quote if quoted)
}
```

Response payload:

```ts
interface CompleteFileRefsResponseData {
  items: AutocompleteResponseItem[]; // existing shared type: { value; label; description? }
}
```

Behavioral contract:

- If `prefix` is not an `@`-token, the client does not send the command (gating is client-side).
- If `fd` is unavailable, the server returns `items: []` and emits at most one `notify` warning per connection/session (toast via the existing extension UI bridge — `notify` is fire-and-forget and is **not** gated by voice mode, so the warning still surfaces during a voice call).
- Directory items carry a trailing `/`; file items are terminal insertions.

#### 2) Warning transport (fd missing)

Reuse the existing fire-and-forget bridge — no new protocol event:

```ts
{
  type: 'extension_ui_request',
  sessionId,
  method: 'notify',
  message: 'fd not found — file autocomplete is unavailable. Install fd to enable it.',
  notifyType: 'warning'
}
```

Emitted at most once per connection/session when autocomplete is requested and `fd` is missing. Client shows it via the existing `ExtensionStatus` notify handler.

## Technology Choices

### A) Dedicated `complete_file_refs` command vs reusing the generic `complete_args` pipeline

- **Option 1 (chosen): dedicated `complete_file_refs` command, reusing the generic response type + dropdown.**
  - `@` is not a slash command, so it must not appear in `get_commands`, and its client-side trigger (an `@`-token anywhere in the line) differs from `complete_args` (which keys off `/command <args>`). A dedicated command keeps that boundary clean.
  - It still reuses the shared `AutocompleteResponseItem` type and the existing `CommandAutocomplete` render/debounce machinery, so there's no duplicated UI plumbing.

- **Option 2: fold `@` into `complete_args`.**
  - Would force a synthetic pseudo-command and bend the slash-arg trigger model to cover mid-line `@` tokens. More coupling, no real savings.

### B) `fd` missing behavior

- **Option 1 (chosen): no suggestions + one-time warning toast.**
  - Deterministic and simple; matches the TUI's non-blocking degradation (TUI returns `[]` when `fd` fails). The input still works — `@` text is just typed manually.

- **Option 2: fall back to a `readdirSync`-based listing.**
  - The TUI does have a non-`fd` `getFileSuggestions` path, but reproducing it server-side adds complexity for a degraded-mode-only case. Deferred; revisit if `fd`-absent environments turn out to be common.

### C) Expansion / injection (explicitly out of scope)

- We do **not** expand `@` refs into `<file>` blocks or attach images. That is the CLI `processFileArguments` behavior, not the interactive TUI behavior we are matching. The agent reads referenced files via its `read` tool. Dropping expansion removes the need for `message-mapper` changes, an `attachment` content block, `Message.svelte` attachment rendering, and `images` on `steer`/`follow_up`.

## Tests

**Pre-test-write commit:** `58f8b4973c14bb245015401d265bf26983422e68`

### Interface Files

- `shared/src/protocol.ts` — adds the `CompleteFileRefsCommand` (`type: 'complete_file_refs'`, `prefix`) and wires it into the `PimoteCommand` union. Response reuses the existing `AutocompleteResponseItem` shape. No `PromptCommand`/`SteerCommand`/`FollowUpCommand` changes, no `images`, no message-content changes.
- `server/src/file-references.ts` — the `completeFileRefs` contract: `CompleteFileRefsInput` (`prefix`, `cwd`, optional `fdPath`, optional `runFd` test seam), `CompleteFileRefsResult` (`items`, `fdAvailable`), and the `FdRunner`/`FdInvocation`/`FdRunResult` seam types that surface the fd argument vector + resolved `baseDir`/`query` for substitution in tests. Skeleton only (`throw 'not implemented'`).
- `server/src/ws-handler.ts` — integration scaffolding: `complete_file_refs` dispatch case resolving the session's `folderPath` as cwd, calling `completeFileRefs`, returning `{ items }`, and emitting a one-time fd-missing `notify` warning (`emitFdMissingWarning`, guarded by a per-connection `fdWarningEmitted` flag) over the existing fire-and-forget extension-UI bridge.
- `client/src/lib/file-ref-prefix.ts` — the client-side `extractFileRefPrefix(textBeforeCursor)` pure helper contract (skeleton only).

### Test Files

- `server/src/file-references.test.ts` — exercises the `completeFileRefs` boundary via an injected capturing `runFd` seam: fd argument construction, base-directory resolution, item mapping/quoting, and fd-availability degradation.
- `client/src/lib/file-ref-prefix.test.ts` — exercises `extractFileRefPrefix`: `@`-token boundary detection, quoted `@"…"` tokens, and non-trigger cases.

### Behaviors Covered

#### `completeFileRefs` (server file-references)

- Always invokes fd asking for both files and directories, hidden, following symlinks (`--type f --type d --hidden --follow`).
- Always excludes `.git` and caps results (`--exclude .git`, `--max-results`).
- Passes a bare single-segment prefix (`@comp`) as the fd query pattern.
- Scopes a multi-segment prefix by splitting at the last `/`: `@src/comp` queries fd with `query: 'comp'` and `baseDir: <cwd>/src`, and does **not** pass `--full-path` (the scoped query never contains a separator). Guards against a naive impl that sets `--full-path` off the raw prefix while scoping the query.
- Resolves a bare relative prefix against the session cwd.
- Treats a trailing `/` as "list the contents of this directory" (empty query, base = that directory) for named subdirs, `./`, `../`, absolute `/…`, and `~/`.
- Expands `~/` to the home directory for the search root, while keeping the typed `~/` scope in the inserted token (not the expanded path).
- Maps a file entry to an `@`-prefixed terminal token; gives directory entries a trailing `/` in the inserted token.
- Reconstructs the full token by prepending the typed directory scope (e.g. `@src/` + `index.ts` → `@src/index.ts`).
- Quotes the inserted token when the path contains a space, or when the prefix was already a quoted `@"…"` token.
- Reports `fdAvailable: true` with mapped items when fd runs; `true` with no items when fd matches nothing; `false` with no items when the fd binary is missing (degradation + warning signal).

#### `extractFileRefPrefix` (client)

- Returns `null` for empty text, text with no `@`-token, slash commands, and a token already terminated by a trailing space.
- Extracts a bare `@`-token at the start of the line, a lone `@`, and an `@`-token following whitespace mid-line.
- Extracts only the token immediately before the cursor when multiple `@`-tokens are present.
- Does not trigger on a mid-word `@` (e.g. an email address); triggers when `@` follows a non-space delimiter (e.g. `=`).
- Captures an unclosed quoted `@"…"` token including its opening quote and any spaces inside it.

**Review status:** approved
