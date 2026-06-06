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

Driver: `tools/manual-test/at-file-syntax-smoke/at-file-syntax-smoke.mjs`
(new). Final run: **all assertions pass**.

**Phase A — `complete_file_refs` over WS (against a real opened session,
known on-disk tree):**

- `@` lists the whole cwd tree; dir tokens carry trailing `/`
  (`@src/`, `@docs/`), file tokens are terminal (`@top.txt`), the spaced
  dir surfaces quoted (`@"my dir/"`). — **pass**
- `@to` bare single-segment query → `@top.txt`. — **pass**
- `@src/` last-slash scoping → `@src/index.ts` + `@src/util.ts`, labels
  scope-relative (`index.ts` / `util.ts`). — **pass**
- `@src/ind` scoped query → `@src/index.ts` only. — **pass**
- `@"my d` quoted token with a space → `@"my dir/"`. — **pass**
- `@"my dir/` quoted-directory drill-in → `@"my dir/note.txt"` (review
  finding #2 regression guard, server side). — **pass**

**Phase A2 — `fd` missing degradation:** second pimote booted with
`fd`/`fdfind` stripped from `PATH`. `complete_file_refs` returns
`items: []`, emits exactly one `extension_ui_request` notify warning
(`notifyType: 'warning'`, message names `fd`), and does NOT re-emit on a
second request (per-connection one-shot). — **pass.** (The focus hint
flagged this path as likely unreachable because `fd` is present; the
driver forces it reachable by sanitizing `PATH`, so it IS exercised.)

**Phase B — InputBar interaction (agent-browser, real Chromium):**

- Typing `@` opens the fd-backed dropdown (8 suggestions). — **pass**
- Selecting a file inserts `@top.txt` and closes the menu. — **pass**
- Selecting a directory inserts `@src/` and keeps the menu open; drilling
  in offers `index.ts`/`util.ts`; selecting `index.ts` →
  `@src/index.ts`. — **pass**
- Quoted-directory drill-in (UI level, review finding #2): `@my` →
  `my dir/` → inserts the open quoted token `@"my dir/`, menu stays open
  with `note.txt`, selecting it → `@"my dir/note.txt"`. — **pass**
- `@` triggers mid-line (`please read @to`). — **pass**
- `/` opens the slash-command dropdown (`new`/`reload`/`tree`/`login`)
  and shows no file refs — `@` and `/` mutually exclusive. — **pass**
- Composed `check @top.txt now` sends; the optimistic user message shows
  the literal `@top.txt` token unchanged (no server-side expansion). —
  **pass**

**Coherence (Phase B screenshot `at-file-syntax.png`, `AT_SHOT=`):**
looks coherent — the dropdown renders fd paths cleanly, inserted tokens
match the typed-scope reconstruction, and the sent message echoes
`@top.txt` verbatim in the transcript with no `<file>` block or
attachment chrome (matching the autocomplete-only intent).

No issues were found; nothing fixed inline.

## Plan Updates

Updated `tools/manual-test/PLAN.md` Journey 2 to note the `@`-file-path
autocomplete as part of prompt composition and to name the new
`at-file-syntax-smoke` driver for its settled (non-live-stream) behavior.
No new standalone journey was promoted — `@` completion is an
enhancement to the existing prompt-input path, not a separate primary
journey.

## Open Issues

None. All Phase A / A2 / B assertions pass; the `fd`-missing warning path
was exercised (not left unreachable). `steer` / `follow_up` were not
driven live — they share the same forward-`command.message`-unchanged
handler as `prompt`, noted under Harness Limitations.
