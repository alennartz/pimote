# DR-063: Hub disband removed from every surface

## Status

Accepted

## Context

Hub disband existed as a wire command (`disband_hub`), a dashboard row-menu action with a confirm dialog, and (for one day) the manager tool `pimote_disband_hub`. It read as "dissolve the grouping": remove the hub, keep the members. But a hub is not a shell. A code hub is a working git repo that can carry its own code. A persona hub is the agent itself — its `AGENTS.md` prompt and its `memory.md` live in the hub folder. Disband is `rm -rf` on all of that; the members survive only because `rm` unlinks symlinks instead of following them. A one-click destructive action whose name promises less than it does is a footgun, on every surface at once.

Owner ruling (2026-01-14): remove the feature completely — wire message, UI element, manager tool, and the registry method behind them.

## Decision

**Hub disband is gone from every surface.** The `disband_hub` wire command, the dashboard menu item and dialog, the manager tool, and `FolderRegistry.disbandHub` are deleted. There is no replacement operation. Hubs are created through the wizard, the wire, and `pimote_create_folder` as before.

**Deleting a hub is a file-level action, not a folder-model action.** A hub folder is deleted like any other folder — by hand, or by an agent with file tools. The folder model observes the deletion on its next discovery pass. We rejected keeping a registry-level delete with better wording: the blast radius (committed code, a persona's prompt and memory) does not shrink because the confirm dialog grows, and pimote's folder operations should curate and structure, not destroy content.

## Consequences

- Breaking wire change: `DisbandHubCommand` leaves the protocol with no compat shim. The Android client does not implement folder management, so no consumer breaks.
- At the time of this ruling, a hand-deleted registry hub left a stale row. DR-064 removed hub ownership records: a deleted shaped hub now disappears on the next discovery pass, with no stale entry to clean up.
- At the time of this ruling, `FolderInfo.repos` still described registry-listed membership. DR-064 makes the symlink shape the membership truth for every hub; `repos` carries code-member git facts and does not gate membership mutations.
- Source-listed hubs remain source-owned promises. If deleted on disk, their row shows missing until the source hub materializes again on open.
- The manual drivers that exercised disband (project-management-smoke section W, folder-paging-smoke reconnect check) were repointed: the former asserts creation effects only, the latter uses archiving to drive the no-phantom-row reconnect case.
