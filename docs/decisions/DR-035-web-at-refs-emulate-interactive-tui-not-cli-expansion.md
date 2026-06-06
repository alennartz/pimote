# DR-035: Web `@` file refs emulate interactive-TUI autocomplete, not CLI server-side expansion

## Status

Accepted

## Context

Pimote's web input gained TUI-style `@file` references. The original framing (brainstorm + first draft of the plan) assumed parity with pi's `@` should mean **server-side expansion at send time**: the server would resolve each `@path` token, inline text files as `<file>` blocks, and materialize images/PDFs as attachments before forwarding the message to the SDK — mirroring the CLI's `processFileArguments`. That framing rippled into a large surface: an `attachment` content block in the protocol, `images?: string[]` on `prompt`/`steer`/`follow_up`, an `expandFileRefs` server function, `message-mapper` changes to emit attachment blocks, and `Message.svelte` work to render them.

A mid-pipeline architecture audit (then `docs/reviews/at-file-syntax-web-architecture-audit.md`) forced a closer look at what pi actually does, and surfaced that pi has **two different** `@` behaviors:

- **Interactive TUI** (`CombinedAutocompleteProvider`): `@` only drives autocomplete — it shells out to `fd` and inserts the chosen path back into the editor. At submit, the raw `@path` text is passed to `session.prompt(text)` **unchanged**. `prompt` expands `/`-commands, skills, and prompt templates, but does **not** expand `@` references — they reach the model as plain text, and the agent reads them with its own `read` tool.
- **CLI** (`pi @foo.png "…"`, `processFileArguments`): inlines text files as `<file>` blocks and attaches images.

The brainstorm had conflated these. The user's actual intent — "behave like the TUI" — pointed at the interactive autocomplete-only behavior, not the CLI expansion behavior.

## Decision

Emulate the **interactive TUI** behavior only. The web client surfaces an `fd`-backed `@` autocomplete menu and inserts the chosen path token; the literal `@path` text is sent through the existing `prompt`/`steer`/`follow_up` commands **unchanged**, with no server-side resolution. The agent reads referenced files via its own `read` tool, exactly as in the TUI.

All CLI-style expansion scope was deliberately dropped: no `expandFileRefs`, no `<file>` inlining, no image/PDF attachment materialization, no `message-mapper` attachment-emission path, no `Message.svelte` attachment rendering, and no consumption of the `images?` fields on the queue commands. The earlier draft of the plan that targeted CLI-style expansion was superseded.

## Consequences

- **Massively narrowed implementation.** The feature collapsed to four moving parts: a `complete_file_refs` autocomplete command, an `fd`-backed `completeFileRefs` server module, a client `@`-token extractor, and an `@` trigger mode in the input. The send path was untouched — `@path` is ordinary message text.
- **The web client cannot reference files the agent cannot itself read.** Because nothing is inlined, `@`-referencing a file only helps if the agent's `read` tool can reach it from the session cwd. This is identical to the TUI's contract, so it's parity, not a regression — but it is a real limitation versus the CLI, which can attach files the agent wouldn't otherwise load.
- **No image/PDF attachments from the web composer via `@`.** The CLI can attach images through `@`; the web `@` cannot. If image attachment from the web is wanted later, it is net-new work, not a finish of this feature.
- **No orphaned scaffolding remains.** An earlier exploratory test-write commit had landed an `attachment` content block and `images?: string[]` on `steer`/`follow_up` at the type level. That commit was reverted in full during the architecture re-validation, before the corrected (autocomplete-only) pipeline ran, so none of it survives. The only `images?` field in the protocol is the **pre-existing** one on `PromptCommand`, which is legitimately consumed by the composer's paste/share image path and is unrelated to `@` refs. There is intentionally no code path that expands `@` server-side, and no dead expansion types to mistake for a half-built feature.
- **If CLI-style expansion is ever wanted**, revisit this DR: the reason it was dropped is that the user wanted TUI parity, and the TUI does not expand. That intent is the thing to re-check, not the technical feasibility.
