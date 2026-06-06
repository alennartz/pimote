# Audit: at-file-syntax-web plan vs current code

Audit of `docs/plans/at-file-syntax-web.md` against the repo as of this commit. Each plan item classified; cites are `file:line`.

## Summary

A surprising amount of the plan has already been landed at the **type/skeleton level** (protocol types, server module stub + tests, `attachment` content block) but the **wire-up is missing on both server and client**. The biggest conceptual hit is autocomplete: the codebase has since grown a generic `complete_args` autocomplete pipeline (`shared/src/protocol.ts:307-326`, `client/src/lib/components/CommandAutocomplete.svelte:24-65`, `server/src/ws-handler.ts:1041`) that the plan's bespoke `complete_file_refs` command predates and does not align with. The plan's response shape coincidentally already uses `AutocompleteResponseItem` (`shared/src/protocol.ts:212`), but the _command_ and _trigger pathway_ in `InputBar` are still slash-only.

## Per-decision drift

### Client — InputBar + CommandAutocomplete (`@` trigger)

**Drifted / partially superseded.**

- Plan: extend slash autocomplete with a separate `@` request path emitting `complete_file_refs`.
- Reality: `InputBar.svelte` autocomplete is hard-gated to text starting with `/` (`client/src/lib/components/InputBar.svelte:156-159, 32-36`); there is no `@` detection. `CommandAutocomplete.svelte` is now a _generic_ request component — its args mode already debounces, fires `complete_args`, and renders `AutocompleteResponseItem[]` (`client/src/lib/components/CommandAutocomplete.svelte:1-2, 32-65`).
- Implication: the _response_-side machinery (debounced fetch, stale-discard, render) is reusable; the plan's claim of "add a separate request path" is correct, but the plan still describes `complete_file_refs` as a bespoke command, where the natural fit now is to either (a) reuse the generic `complete_args` pipeline with a synthetic command name or (b) replicate the same shape under a new command. The plan does not acknowledge that this pipeline exists.

### Client — Connection / session-registry (optimistic + send)

**Still valid.**

- `addOptimisticUserMessage` and reconciliation are intact (`client/src/lib/stores/session-registry.svelte.ts:165-179, 283-328`). `InputBar` still calls it after a successful `prompt` (`client/src/lib/components/InputBar.svelte:240-247`). No structural drift to the path the plan promises to preserve.

### Client — Message rendering (attachment metadata)

**Drifted (block-aware infra exists but user role still text-only).**

- Plan: extend user-message rendering to support attachment blocks.
- Reality: `Message.svelte`'s user branch flattens `content` to a single text join (`client/src/lib/components/Message.svelte:63-67, 90-156`) — it explicitly does _not_ iterate blocks for `role === 'user'` the way it does for assistant (`Message.svelte:199-216`). So attachment blocks would currently be invisible. Net plan work here is still needed; the protocol-side type is already there (see below).

### Protocol — `PimoteMessageContent` attachment block

**Already landed (plan item complete).**

- `PimoteMessageContent` already includes `type: 'attachment'` with `name`, `path`, `kind: FileRefKind`, `mimeType` (`shared/src/protocol.ts:77-95`). The plan's "extend message content union" is done at the type level. Producer (server mapper) and consumer (Message.svelte user branch) are still unchanged — see drift items above and below.

### Protocol — `PromptCommand` / `SteerCommand` / `FollowUpCommand` `images`

**Already landed at type level; client/server still text-only for steer/follow_up.**

- All three commands now declare `images?: string[]` (`shared/src/protocol.ts:180-197`). Plan's "extend `steer`/`follow_up` for attachment parity" is done in the wire contract.
- BUT: server `ws-handler.ts` `steer` / `follow_up` handlers pass only `command.message` to `session.steer(...)` / `session.followUp(...)` (`server/src/ws-handler.ts:853-872`); `command.images` is ignored. Client `InputBar.svelte:217-225` explicitly only sends text for steer ("text only, no images" comment). So the type extension is unconsumed today. Plan should treat steer/follow_up image plumbing as _not yet_ implemented end-to-end.

### Protocol — `CompleteFileRefsCommand` + response

**Already landed (declared, but unhandled server-side).**

- `CompleteFileRefsCommand` declared (`shared/src/protocol.ts:204-209`), response shape `CompleteFileRefsResponseData` declared (`shared/src/protocol.ts:211-214`), command union includes it (`shared/src/protocol.ts:544`). Response already uses generic `AutocompleteResponseItem` (line 212, 321) — plan's bespoke `FileRefAutocompleteItem` type in `file-references.ts:24-31` _duplicates_ this shape inside the server module. Net: protocol is fine; the plan's internal shape choice diverges from the rest of the autocomplete pipeline for no apparent reason.

### Server — `ws-handler.ts` command handling

**Missing.**

- No `case 'complete_file_refs'` in the switch (verified by grep). `prompt`/`steer`/`follow_up` handlers don't pass through any file-ref expansion — they call `session.prompt/steer/followUp` directly (`server/src/ws-handler.ts:825-872`). All routing work the plan describes is still net-new.

### Server — `file-references.ts` (new module)

**Net-new — partially landed as stub.**

- `server/src/file-references.ts` exists with exported `completeFileRefs` and `expandFileRefs`, but both throw `Error('not implemented')` (`server/src/file-references.ts:64, 124`). Companion test file `server/src/file-references.test.ts` (179 lines) exercises the contract. The plan's shape matches what's there. No real audit drift here — implementation just isn't written yet.

### Server — `message-mapper.ts` SDK→wire mapping

**Drifted (not block-aware for attachments).**

- `mapAgentMessage` handles `text`, `thinking`, `toolCall`, `image` (downgraded to `[image]` text placeholder), and unknown→text fallback (`server/src/message-mapper.ts:131-156`). No `attachment` emission path; SDK `image` is _dropped_ into a text placeholder rather than mapped to an `attachment` block. The plan's "map SDK user content blocks into attachment-aware wire content blocks" is unimplemented and conflicts with the current image-collapsing behavior — plan should note it has to replace, not just add to, this branch.

### Server — `session-manager.ts` cwd + UI bridge reuse

**Still valid.**

- `ManagedSlot.folderPath` is the session cwd, surfaced to the extension UI bridge already (`server/src/extension-ui-bridge.ts:34, 28`); `notify` is the existing fire-and-forget channel (`server/src/extension-ui-bridge.ts:136-139`). Plan's assumption stands.

### Server — Warning toast via `extension_ui_request` + `notify`

**Still valid — and notably not gated by voice mode.**

- The extension UI bridge now short-circuits _dialog_ methods (`select`/`confirm`/`input`/`editor`) with `UI_BRIDGE_DISABLED_IN_VOICE_MODE` when a voice call is active (`server/src/extension-ui-bridge.ts:29-31, 100-130`), but `notify` is fire-and-forget and is _not_ gated (`server/src/extension-ui-bridge.ts:136-139`). The plan's warning-toast path therefore still works in voice mode. Worth noting in the plan so future readers don't assume otherwise, but no structural change required.

### Server — `get_commands` autocomplete surface

**Superseded (and the plan should acknowledge it).**

- The current generic autocomplete pipeline: `get_commands` returns `CommandInfo[]` with `hasArgCompletions` flag (`server/src/ws-handler.ts:997-1039`); `complete_args` returns `AutocompleteResponseItem[]` per (commandName, prefix) (`server/src/ws-handler.ts:1041` ff; protocol `shared/src/protocol.ts:307-326`). Client wires this through `CommandAutocomplete.svelte:42-65`. The plan invents `complete_file_refs` independent of this surface. That's a valid choice — `@` is not a slash command — but the plan needs to call out the decision instead of looking like it didn't know the generic pipeline existed.

### Client — `command-store.svelte.ts`

**Unaffected.**

- The per-session cache is for slash-command lists (`client/src/lib/stores/command-store.svelte.ts:7-21`). It doesn't interact with `@` autocomplete in any way the plan describes. Plan can ignore.

## Other conceptual issues newly visible

1. **Plan's `FileRefAutocompleteItem` duplicates the shared `AutocompleteResponseItem`.** `server/src/file-references.ts:24-31` defines `{value, label, description?}` — byte-identical to `shared/src/protocol.ts:321-325`. Plan should drop the internal type and reuse the shared one.

2. **Steer/follow_up images: protocol claims it, code rejects it.** Type-level `images?: string[]` (`shared/src/protocol.ts:189, 195`) is unread by `ws-handler.ts:853-872` and unsent by `InputBar.svelte:217-225`. Plan currently assumes adding it is uncontroversial; in reality there is a half-finished landing the plan needs to either finish or stop trumpeting.

3. **`mapAgentMessage` currently collapses SDK `image` content to `'[image]'` text** (`server/src/message-mapper.ts:147-148`). The plan's attachment-aware mapping must explicitly supersede this branch, not coexist with it.

4. **User-message rendering ignores non-text blocks today** (`client/src/lib/components/Message.svelte:63-67`). Plan's "preserve current user bubble conventions" undersells the work: there is no block iteration to extend — one must be added.

5. **Generic autocomplete pipeline exists** (see "Server — `get_commands`" above). Plan should at minimum acknowledge it and justify why `@` doesn't reuse `complete_args`. The strongest justification on the table is that `@` is not a slash-prefixed command and shouldn't appear in `get_commands`; that's a reasonable answer, but the plan must say it.

## Classification roll-up

| Plan item                                     | Class                                      |
| --------------------------------------------- | ------------------------------------------ |
| InputBar `@` trigger wiring                   | Drifted                                    |
| CommandAutocomplete reuse for `@`             | Superseded (generic pipeline now exists)   |
| Connection / optimistic preserve              | Still valid                                |
| Message.svelte attachment rendering           | Drifted (user role still text-only)        |
| `PimoteMessageContent.attachment` type        | Already landed                             |
| `PromptCommand.images`                        | Already landed                             |
| `Steer/FollowUpCommand.images` (type)         | Already landed; **unconsumed by handlers** |
| `CompleteFileRefsCommand` (type)              | Already landed                             |
| ws-handler `complete_file_refs` handler       | Missing                                    |
| ws-handler `prompt/steer/follow_up` expansion | Missing                                    |
| `file-references.ts` module                   | Net-new — stub landed, impl not            |
| `message-mapper.ts` attachment mapping        | Drifted (current code drops SDK images)    |
| session-manager cwd + UI bridge reuse         | Still valid                                |
| Warning toast via `notify`                    | Still valid (not voice-gated)              |
| `command-store` interaction                   | Net-new — unaffected                       |
