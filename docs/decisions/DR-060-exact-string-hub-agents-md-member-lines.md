# DR-060: Hub AGENTS.md member lines are exact-string managed content

## Status

Accepted

## Context

Hubs are folders composed of member shortcuts. Each member gets a link line seeded
into the hub's `AGENTS.md`, inside a marked block
(`<!-- pimote:members (managed block) -->` … `<!-- /pimote:members -->`). Users edit
`AGENTS.md` freely. Member add/remove must update the seeded lines without harming
user prose. The obvious alternative — regenerate the managed block (or the document)
on each mutation — reflows or drops user content, because the mutator cannot tell its
own output from edits the user made to it.

## Decision

The mutator owns only the exact byte strings it seeded. Injection and removal are
exact-string surgery: insert the known seeded line before the closing marker, or
delete that exact line byte-for-byte. It never rewrites, reflows, or regenerates
surrounding content. A seeded line not found byte-exact is left alone. If the block
markers are gone, add appends a fresh block; remove does nothing.

The chosen trade-off: dead links are acceptable, mangled user files are not.

## Consequences

- User edits to seeded lines survive; the mutator silently stops managing them.
- A renamed or deleted member can leave a dead link line behind when its exact seeded
  line no longer matches. Removal only drops the lines it can match byte-exact.
- Line wording must stay byte-deterministic per (name, nature) — wording changes
  orphan previously seeded lines. Seeded renderers live in `server/src/folder-seeding.ts`
  so creation and mutation cannot drift.
- Anything that reformats `AGENTS.md` (reflow, prettier-style tools) permanently
  opts that file out of membership management.
