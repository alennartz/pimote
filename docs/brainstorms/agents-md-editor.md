# Brainstorm: AGENTS.md Editor

**Date:** 2026-10-04
**Status:** converged

## The Idea

A first-class pimote feature to manually edit the user-level AGENTS.md file (`~/.pi/agent/AGENTS.md`) from the UI. This is deliberately framed as the beginning of a future server-configuration workflow in the UI, designed carefully for desktop and mobile at once.

## Key Decisions

### Scope: user-level AGENTS.md only

Only `~/.pi/agent/AGENTS.md` — not project-level AGENTS.md, not other files. The seam should be left roomy enough ("config file editing") to grow, but the feature itself covers exactly one file. _Why:_ avoids premature generalization while keeping the door open for the future config workflow.

### Editing model: raw markdown editor + tag-wrap toolbar

A raw CodeMirror markdown editor with save/cancel — not a section-based editor, not agent-assisted editing. _Why:_ honest about what the file is, identical behavior on desktop and mobile, no parsing complexity. Agent-assisted editing was considered and rejected: it drags session machinery into what should be a simple config surface.

Added on top: a quick **XML tag insertion** flow (see below). Note: pi treats AGENTS.md as plain markdown with no tag semantics — the tags are the user's own structuring convention, so the palette is a product decision, not a protocol one.

### Placement: one button on the home page, no settings home

An unobtrusive button on the home page (project list) that directly opens the editor UI, opened "like it does today" — the same dialog-style editor the extension UI uses (CodeMirror, open/save/cancel). No Settings destination, no navigation furniture. _Why (rejected alternative):_ building a Settings home now with one entry was proposed and rejected — the user wants minimal chrome; the config workflow can grow its own navigation when there's more than one thing to configure.

### Conflict handling: none — last-write-wins

Optimistic concurrency (mtime/hash version token, "changed on disk" prompt) was proposed and explicitly rejected as over-engineering. Save is a plain write. _Why:_ the user is the only realistic writer and accepts the risk.

### Tag wrap flow: toolbar button → inline input

The primary wrap flow is freeform: tap a tag button in the editor toolbar, a one-line input appears, type any tag name and press Enter (or tap Wrap), and the pair `<tag>…</tag>` is inserted around the cursor/selection. Rules:

- With a selection: wrap it inline.
- Without: insert the pair on separate lines, cursor lands on the blank middle line.

Identical on desktop and mobile; desktop may additionally get a keyboard shortcut. _Why (rejected alternative):_ a "command-bar" magic cursor-attached entry was rejected as too much state.

### Snippets: user-defined, stored in server config JSON

Tags the user reaches for often are defined as a list in the server config JSON (hand-edited for now) and rendered as one-tap buttons next to the wrap input. _Why (rejected alternative):_ an auto "recent tags" list was rejected because the requirement is genuinely _user-defined_. Deliberately exercises the config seam this feature is the start of; snippet-management UI comes later with the config workflow.

## Direction

One unobtrusive home-page button → dialog-style raw markdown editor for `~/.pi/agent/AGENTS.md` (dialog on desktop, effectively full-screen on mobile) → wrap-tag toolbar (freeform tag input + one-tap snippet buttons from server config) → simple save, last-write-wins.

## Open Questions

### Sharp (inputs to architecting)

- How does the server expose read/write of this single file over the existing WS/HTTP protocol? (New command pair vs. reusing existing file plumbing.)
- Does the existing editor dialog need mobile-specific work (sizing, keyboard avoidance), or does the extension editor UI already handle mobile well?

### Deferred intent

- Whether the seam should later point at other config files (project AGENTS.md, settings.json, etc.). Not a commitment — revisit when the config workflow lands.

### Fog

- "Server configuration workflow in the UI" as a future direction — shape unknown. Dies with this artifact unless promoted.
