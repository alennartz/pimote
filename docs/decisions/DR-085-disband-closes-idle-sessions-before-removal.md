# DR-085: Disband closes idle sessions before removal

## Status

Accepted

## Context

DR-080 restored worktree-hub disband behind an activity guard that rejected whenever any live session sat in the hub subtree, whatever the session was doing. That guard made the common retirement a two-step dance: the user or agent finishes work in the hub, leaves the session idle, then must close the slot by hand before disband accepts.

The server already owns the machinery for retiring a session safely. The idle reaper classifies a slot as uncloseable while it has observers, an active call, bash in flight, tree navigation, an unsettled run, or extensions reporting background work, and closes eligible slots through the canonical `closeSession` lifecycle. Archiving an open session evicts its slot the same way. Disband stood alone in treating any live session as a hard block, duplicating a judgment the server already makes — just later, on a timer.

> Supersedes DR-080 (Worktree hubs — detached code members with guarded worktree-only disband), last recorded at commit `c7983414fe42ff823042d0fb2a532de92af897f1`.
>
> DR-080 itself superseded DR-063 (Hub disband removed from every surface) and DR-064 (Hub shape is membership truth; registry stores curation only). That supersession chain carries over to this record.

## Decision

**Disband behaves like archive for sessions.** Before removing a worktree hub, the disband guard closes every idle, observerless session slot rooted at the hub or its nested worktree checkouts, immediately and through the canonical close lifecycle — not by waiting for the idle reaper. Sessions that are still working or observed keep rejecting the disband, as do external pi processes. A slot whose close fails counts as still hosted: the guard fails closed rather than removing a hub over an uncloseable session.

The session manager owns the classification and the close, reusing the reaper's busy rule minus the idle-timeout wait, serialized through the same per-slot operation lock. The registry reaches it only through the narrow `HubActivityPort` seam, so folder-registry code never touches the session manager — the port's `closeIdleSessionsAt` closes what it can and reports the requested paths that remain busy.

We rejected waiting for the idle reaper: it would turn disband into a retry-until-timeout loop paced by a config value that has nothing to do with the hub. We rejected keeping the reject-on-any-live-session rule: it forces a manual close for a slot the server would reap on its own within minutes, and the agent consumers most likely to create worktree hubs are the least likely to perform that ritual. We rejected a bespoke close path inside the guard: forking the close logic would drop the reaper's protections the first time one of them evolved.

The rest of DR-080 stands unchanged: per-hub member representation with symlinks as the default, detached worktree creation from source `HEAD` with all branch lifecycle work left to the user or agent, shape-derived membership with the minimal worktree-mode marker, canonical member identity with the nested checkout carried separately, the clean-state and detached-`HEAD` reachability guards, and the shared registry seam behind the dashboard command and the `pimote_disband_hub` manager tool.

## Consequences

- Disband can close a session the user forgot about. Nothing is lost: pi persists the session file, and reopening restores it. A session someone still watches is never closed.
- An idle session inside a dirty or unreachable checkout is closed by an attempt that then rejects on the worktree guard. A retry after fixing the worktree finds no session in the way.
- The activity guard now performs a mutation, not just a check; its fail-closed rule extends to close failures, so an uncloseable slot blocks the disband instead of vanishing silently.
- Two callers — the reaper and disband — share one busy rule. A new protection added to the reaper's predicate now protects disband too.
