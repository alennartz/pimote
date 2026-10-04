# Manual Testing — agents-md-editor

**Run:** 2026-10-04, light pass (focus hints: minimal manual testing; cover only
the new AGENTS.md editor flow; skip all unchanged surfaces and mobile
soft-keyboard probing — a recorded accepted gap in `docs/plans/agents-md-editor.md`).

## Smoke Suite

The subset of `tools/manual-test/PLAN.md` journeys exercised this run:

- **Journey 13 — AGENTS.md editor** (new this run, see _Plan Updates_): the
  topic's own journey — home-page button → dialog on `~/.pi/agent/AGENTS.md` →
  edit/save → tag-wrap toolbar → cancel/discard-confirm. Driven end-to-end.
- Journey 1 (connect and open a session) is exercised only as far as the
  driver needs: the PWA loads and renders the dashboard home (which hosts the
  entry button).

All other journeys were deliberately **not** exercised: the focus hints scope
this run to the AGENTS.md editor flow only (unchanged surfaces: sessions,
manager, voice, projects, downloads).

## Topic-Specific Tests

Behaviors specific to this topic (all via the new
`tools/manual-test/agents-md-editor-smoke/` driver, real server + real PWA):

1. **Entry button + open.** The home-page "Agent instructions" button (Projects
   header) opens the dialog titled "Agent instructions", header shows the
   resolved absolute path ending `/.pi/agent/AGENTS.md`, and the editor loads
   the file's real content. Toolbar shows the Tag button and the snippet
   palette from `~/.config/pimote/config.json` (`tagSnippets: ["note","todo"]`).
2. **Edit + save round-trip.** Type new text through the real input path →
   Save → dialog closes → the file on disk contains exactly the edited text.
   Reopening shows the saved content (residual-state check: the load path and
   dirty baseline are reset).
3. **Tag-wrap, freeform.** Select a word → Tag → type `mytag` → Enter: the pair
   `<mytag>…</mytag>` wraps the selection inline and the selection is restored
   on the inner range.
4. **Tag-wrap, snippet button.** Collapsed cursor + one-tap `note` button:
   `<note>\n\n</note>` block-inserts at the cursor.
5. **Cancel / discard-confirm.** With unsaved edits, Cancel opens the
   "Discard unsaved changes?" confirmation; "Keep editing" restores a working
   editor with edits intact; Esc is vetoed into the same confirmation (review
   finding 2's second trigger); "Discard" closes without touching disk — the
   file keeps the step-2 saved content.

Coherence pass on the rendered dialog (screenshot), judged against the
brainstorm's intent: unobtrusive entry → raw markdown editor + tag toolbar →
simple save.

## Tools

- Reused: `agent-browser` skill (mandatory browser-domain driver) —
  `open` → `snapshot -i` → snapshot-ref `click` on the entry button, plus
  eval-driven CodeMirror interaction and the coherence screenshot.
- New: `tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs` —
  sandboxed pimote (own HOME/XDG) with a seeded `~/.pi/agent/AGENTS.md`, a
  config with `tagSnippets`, and a one-repo project tree for a plausible
  dashboard; drives the dialog flow end-to-end and asserts disk round-trips.
- Improved: none.

## Harness Limitations

- The sandbox HOME stands in for the operator's real `~/.pi/agent/AGENTS.md` —
  contents are synthetic; realistic-content layout issues (very large files,
  unusual characters) are not surfaced.
- Selection/cursor placement for the wrap tests goes through the CodeMirror
  view seam (`view.dispatch({selection})`) rather than a real mouse drag —
  selection _dynamics_ are synthetic; the wrap semantics themselves run
  through the real toolbar → `wrapWithTag` → editor transaction path.
  If live typing through the DOM (`execCommand('insertText')`) proves flaky in
  headless Chromium the driver falls back to view transactions for text entry
  too (noted in Results if used).
- Single-user, last-write-wins: concurrent-writer behavior (explicitly out of
  scope per the brainstorm) and two-client sync are not exercised.
- Desktop viewport only. Mobile soft-keyboard behavior is unprobed — an
  accepted, recorded gap per the plan; no class of primary-behavior bug this
  run claims to cover depends on it.
- Snippet transport is exercised only on its happy path (valid config with
  `tagSnippets`); the lenient-degradation paths (invalid JSON, absent key) are
  unit-tested only.

None of these gaps covers the topic's primary behavior (open → edit → save →
wrap → discard) — those run against the real server, real file I/O, and the
real PWA, so no escalation is needed.

## Results

(filled after execution)

## Plan Updates

(filled after execution)

## Open Issues

(filled after execution)
