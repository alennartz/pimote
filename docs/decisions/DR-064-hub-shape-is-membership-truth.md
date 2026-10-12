# DR-064: Hub shape is membership truth; registry stores curation only

## Status

Accepted

## Context

The folder registry's JSON document held both curation overrides and a `hubs` list. That list recorded hubs pimote had created, with member paths. The disk walk already discovers any included folder with top-level symlinks to external folders; the hub-link probe already reads those links, including dangling links by their lexical target. Yet the registry list made creator history look like part of hub identity: a hand-built persona hub such as `danny-ocean` appeared as a persona with shortcut members, but lacked the `repos` aggregate. Removal already matched dangling links by their lexical target; the record only authorized removing a link that someone had already deleted by hand, which is no longer membership by shape. This contradicted the folder model's identity rule: shape on disk determines what a folder is.

The user ruling (2026-01-14): if a folder has the core hub shape, membership editing must work regardless of who created it. Member-line edits must stay byte-exact; custom AGENTS.md text that does not match seeded lines must remain untouched. After disband was removed (DR-063), the hub ownership list had no remaining delete-authorization job.

## Decision

**Shape, not creator history, defines hubs.** An included folder with member symlinks is a hub, whether pimote, a user, or another tool created it. The symlink inventory is the membership truth. `members` reports its targets; `repos` reports git facts for code members. A dangling symlink remains in the inventory with its lexically resolved target, so a caller can remove it by the same canonical member path after the member folder disappears.

**The registry document stores curation only.** `registry.json` keeps favorite, archived, and user-tag overrides keyed by canonical path. It no longer writes hub entries. The parser ignores legacy `hubs` and `multiRepo` lists; the next curation write drops those keys. Old hub-list records do not manufacture rows or memberships. On-disk shape or a live source promise does.

**Hub creation materializes, invalidates, then broadcasts.** `createHub` still validates discovered members and creates the symlinks, managed AGENTS.md block, git repo, and `.gitignore`; persona hubs also get the persona marker and `memory.md`. It writes no ownership receipt. It invalidates discovery before broadcasting, so the next list observes the folder from its disk shape. Its return row is built from the materialized members.

**Membership tools operate on any manageable shape.** Add checks the same invariants as before, creates the link, and injects the exact seeded line. If AGENTS.md lacks managed markers, it adds a block. Remove matches the symlink inventory, unlinks only that link, and removes only exact seeded text. It tries both seeded nature variants when the member is missing. It does not regenerate or delete custom text. If someone removed the symlink itself by hand, the folder is no longer a member; remove rejects it rather than consulting stale ownership history.

**Source promises remain distinct.** A folder source can list a hub before it exists. Its `memberPaths` supply a temporary promise row until the hub materializes; after materialization, the symlink inventory takes over. Source metadata is not an ownership receipt and stays outside the curation document.

## Consequences

- `danny-ocean` is fully first-class without adoption or rebuild: its row carries the symlink members and code-member git facts, and `pimote_update_hub_members` edits it.
- Deleting a shaped hub folder by hand makes it disappear from the next scan. No stale hub entry remains to archive or hand-edit.
- Empty, git-less legacy folders listed only in old `hubs`/`multiRepo` data no longer appear as hubs. They have no on-disk shape and no live source promise.
- Moving a member symlink by hand changes membership immediately after discovery refresh. A custom AGENTS.md member line remains unless it exactly matches text pimote seeded; this protects user edits by design.
- Curation remains keyed by canonical path. A move still orphans curation (DR-053).
- Source-listed hubs may show promised members before links exist. Their source owns that pre-materialization metadata; the disk inventory owns membership after materialization.
