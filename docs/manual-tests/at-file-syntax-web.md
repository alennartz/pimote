# Manual Testing — at-file-syntax-web

## Smoke Suite

Scoped by the focus hints to the journeys this topic touches:

- **Journey 1 (Connect and open a session)** — exercised implicitly: the
  driver boots a real pimote against a sandboxed HOME, opens a fabricated
  on-disk session, and renders the InputBar where `@` completion lives.
- **Journey 2 (Prompt → send path)** — only the _send_ half: confirm the
  literal `@path` token flows through `prompt` unchanged (no server-side
  expansion). The streaming-response half is out of scope for this topic.
- **Journey 5 (Slash commands)** — only the mutual-exclusivity contract:
  `@` and `/` autocomplete must not co-fire. Not the full `/tree` flow.

The other primary journeys (3, 4, 6–10) are untouched by this topic and
are not re-smoked here.

## Topic-Specific Tests

The `@`-file-path autocomplete added to the web InputBar. Two layers:

1. **Server endpoint `complete_file_refs`** (WS-level, robust): the
   `fd`-backed path-scoping + item-mapping contract, driven directly over
   the WebSocket against a real opened session with a known on-disk tree.
   - `@` lists the cwd tree (files terminal, dirs trailing `/`).
   - bare single-segment query (`@to`) fuzzy-matches from cwd.
   - last-slash scoping (`@src/`, `@src/ind`) resolves the base dir and
     reconstructs `@src/<entry>` tokens.
   - quoted token with a space (`@"my d`) returns a quoted value
     `@"my dir/"`.
   - quoted-directory drill-in (`@"my dir/`) lists children as
     `@"my dir/note.txt"` (review finding #2 regression guard).
2. **`fd` missing degradation** (WS-level): boot a second pimote whose
   `PATH` excludes `fd`/`fdfind`; `complete_file_refs` returns `items: []`
   and emits exactly one `extension_ui_request` notify warning. (Focus
   hint flagged this path as likely unreachable because `fd` is present —
   we force it reachable by stripping `PATH`.)
3. **InputBar interaction** (PWA, agent-browser): typing `@` opens the
   dropdown with fd-backed suggestions; selecting a file inserts `@path`
   and closes the menu; selecting a directory inserts `@path/` and keeps
   the menu open to drill in; `@` triggers mid-line; `/` slash completion
   stays mutually exclusive; the composed `@path` token appears verbatim
   in the optimistic user message after send.

## Tools

- Reused: `agent-browser` skill (PWA driver), the sandbox-boot pattern
  from `cost-accumulation-smoke` / `static-host-pwa-smoke`.
- New: `tools/manual-test/at-file-syntax-smoke/at-file-syntax-smoke.mjs`.
- Improved: none.

## Harness Limitations

- The fabricated session is opened from disk with no live LLM, so the
  _send_ path is verified via the **optimistic** user-message echo
  (client-side) plus the structural fact that `prompt`/`steer`/`follow_up`
  handlers forward `command.message` untouched — there is no code path
  that rewrites `@` server-side. A real agent round-trip is not exercised;
  this harness cannot surface a hypothetical SDK-level `@` interception
  (there is none in pimote's code).
- `steer` / `follow_up` are the same forward-unchanged code path as
  `prompt`; only `prompt` is driven live. The other two are covered by the
  shared-handler structure, not a separate live send.
- agent-browser drives a real Chromium against the real InputBar, so the
  keyboard/tap interaction, debounced fetch, and DOM rendering are real.
  Mobile tap vs desktop keyboard differences are not separately exercised
  (the dropdown click path is identical).

## Results

_Populated during execution._

## Plan Updates

_Populated during execution._

## Open Issues

_Populated during execution._
