# Brainstorm: Folder model foundation

## The idea

First shippable slice of the unified folder model (P0-2): a **sparse representation of the folder tree**, discovered from configured scan roots, that identifies the folders worth interacting with — code folders and persona folders — and how they link to each other. This is the substrate for the 1.0 ship test (interacting with user-defined teams of agents). The slice ships classification, discovery, and one read-only manager tool; no lifecycle code.

## Key decisions

### Q1 taxonomy: two natures; linkage is an occurrence property, not a folder kind

Folders have exactly one of two natures: **code folder** or **persona folder**. "Reference" is neither a third kind nor an attribute of folders — a **shortcut** is an _occurrence_ of an entry somewhere else in the tree.

Rejected the orthogonal-axes model (nature × linkage as folder attributes) because linkage describes how the tree reaches a folder, not what the folder is — the identity rule below makes multiple reach paths free. Rejected "reference as a third folder kind" because a shortcut doesn't wrap a folder; it _is_ the same folder, appearing again. Evidence from pimote-in-pimote usage: `product-manager` (persona) and `pimote`/`my-pi` (code) coexist in one directory, and out-of-tree paths are reached ad hoc — the tree records reach, the entry records identity.

### The marker: AGENTS.md with agent-definition front matter

A folder is a **persona folder** iff its `AGENTS.md` carries YAML front matter in the my-pi agent-definition format (`name`, `description`, `tools`, `model`; body = persona prompt). A **code folder** is git-initialized with either no `AGENTS.md` or one without the marker. Marker wins over git when both are present. A marker-less, git-less `AGENTS.md` includes nothing (judgment).

Rejected "any folder with an `AGENTS.md` is a persona" — it misclassifies code folders like `pimote` itself, which carries project instructions. The marker is also not new vocabulary: a persona folder's `AGENTS.md` **is** an agent definition, so persona folders and subagent definitions share one format. Bootstrapping cost: no folder classifies as persona today, so `product-manager/AGENTS.md` gains front matter to become one.

### Sparse discovery: scan roots only, stop at included folders

Discovery starts **only** at scan roots configured in the pimote server config (deployment: `~/repos`), descending through **skipped** folders (no git, no marker) until a folder is **included**. Once included, descent stops — nested folders are never separately included. The only further entries from an included folder are its top-level out-of-tree symlinks. During descent, symlinks found in skipped folders are followed like any other folder.

Rejected scanning from the home folder: the manager's working directory is not a scan root. This also settles the earlier "root is special" idea — there is no root exception because `~` is outside the tree entirely.

### Shortcuts restart the algorithm (Q4 settled: nesting = recursion)

A top-level out-of-tree symlink inside an included folder is a **shortcut**. Entering one restarts discovery from the top (descend through skipped folders, include code/persona folders, follow their shortcuts, …). Shortcut chains nest by recursion at every included folder; no special nesting semantics needed.

### Identity: canonical path, visited once, many occurrences

An entry is identified by its canonical path. Discovery visits each entry once; the sparse tree may show it as multiple **occurrences** (e.g. reached by two shortcuts). Rejected per-occurrence identity: a persona is one ongoing conversation no matter how many ways the tree reaches it. Also gives cycle safety for free.

### Q3 persistence: the folder is the memory; conversations stay ephemeral

Re-derived, not inherited from DR-047: a persona persists by **leaving artifacts in its own folder** — today, a `memory.md` linked from its `AGENTS.md`. No conversation/session persistence machinery; each conferral starts fresh and continuity lives in the folder. DR-047's ephemerality stands _because_ memory is folder-resident, and the manager inherits this with no special case.

### Config split: scan roots ≠ manager working directory

Two distinct settings: scan roots (where discovery runs, currently `~/repos`) and the manager's working directory (where the manager persona is rooted, default `~`). The manager folder is persona-by-decree and does not appear in the sparse tree.

### Worktrees: nothing special

Git worktrees keep behaving exactly as they do in my-pi today. Out of scope for this design.

## Direction

Implement as the P0-2.1 pull: a read-only folder-model seam (`server/src/folder-model/`: nature types, marker-aware classifier, sparse scanner with shortcut recursion and visit-once identity), scan-root/manager-root config, and one manager tool reporting the sparse tree ("what folders do I have and what are they?"). Additive only — the running pimote-in-pimote loop is untouched. Design decisions land in a DR (next number after DR-050); `product-manager/AGENTS.md` gets its marker front matter.

## Open questions

**Sharp (technical inputs to architecting):**

- Marker detection strictness: require at least a `name` key, or any YAML front matter? Lean: require `name`.
- Wire shape of the tree report — entries with occurrence lists vs. inline duplicated nodes — and where the types live (`shared/` only if the protocol needs them).
- Whether discovery is computed on demand or cached, given `~/repos` scale (dozens of repos, 500+ session dirs).

**Fog:**

- How the registry's curated projects (`registry.json`) relate to the sparse tree — migration is P1 residual, but overlap is felt now.
- How teams and conferencing (P0-3/4) will consume occurrences — one conversation per entry is assumed.
- Persona name uniqueness: front-matter `name` collisions across folders have no consequence yet.
