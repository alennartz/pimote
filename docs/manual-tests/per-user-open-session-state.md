# Manual Testing — per-user-open-session-state

Topic: server-side per-user open-session profiles
(`docs/plans/per-user-open-session-state.md`). The browser's open-session
list moved into `user-profiles.json` keyed by a client-side user name;
`user_sessions_changed` syncs a user's devices; the settings dialog gains
a User pane.

## Smoke Suite

Focus hints scope this run's smoke suite to the journeys that carry the
running pimote-in-pimote loop and that this topic's diff could disturb:
the connect burst now gates restore dispatch, the dashboard close action
sends `detach_session` instead of `close_session`, archive unlinks
profiles, and the Global Settings shell hosts a new User tab.

| #   | Journey (PLAN.md)                           | Driver                                                   | Why in this run                                                                           |
| --- | ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Connect and open a session                  | `project-management-smoke` (dashboard half)              | `open_session` links; close sends `detach_session`; restore waits for the burst           |
| 2   | Prompt → streamed response (settled halves) | `at-file-syntax-smoke`, `streaming-code-highlight-smoke` | connect flow restructure is on the boot path of every session view                        |
| 4   | Shared session observers                    | `session-observers-smoke`                                | archive unlinks profiles; stale-localStorage boot path changed; close/detach semantics    |
| 12  | Dashboard: folders, hubs, manager           | `project-management-smoke`, `manager-lifecycle-smoke`    | dashboard is the loop's home surface; manager reconnect replays ride the new burst gating |
| 13  | Global Settings                             | `agents-md-editor-smoke`                                 | the User tab shares the `CodeEditorDialog` shell under test here                          |

Deliberately out of scope (feature journeys with no interaction surface
on the session-set path, each passed in its own topic's run): 3 (extension
UI bridge, manual), 5 (tree, manual), 6 (panels, manual), 7 (push,
manual), 8 (voice), 9 (Android), 10 (provider login), 11 (file
downloads), update-notification and static-host smokes.

## Topic-Specific Tests

Driven by the new `tools/manual-test/user-profiles-smoke/` unless noted.

1. **Shared set across a user's browsers** — two browser contexts claim
   the same user; an open in one appears on the other's dashboard; the
   close (detach) on one device drops it from the user's other devices.
   Matters because the feature's headline is one shared set.
2. **Cross-user isolation** — a second user holding the same session
   keeps their link when the first user detaches, and never receives the
   first user's broadcasts.
3. **Settings User pane: adopt a profile chip** (desktop) — chips from
   `list_users` with session counts, current-user marker, click-to-adopt,
   dirty marker + hint, footer Save, reconnect, chips refresh.
4. **Settings User pane: rename to a brand-new user** — deliberate
   switch to an unknown name starts the device's list empty (the seed is
   cleared before reconnect); consequence copy matches the mock.
5. **Settings User pane: mobile header Save** — below 640 px the dialog
   header carries Save; saving from it reconnects to the new profile.
6. **Migration: adopt-once** — a browser with pre-existing local
   open-session state adopts it into a fresh profile on first connect
   (`fresh: true`), and the local mirror key clears.
7. **Migration: stale second browser drops extras** — with an existing
   profile (`fresh: false`), local-only entries are dropped, never
   opened; closed sessions do not resurrect.
8. **Restart survival** — profiles survive a full server restart; a
   fresh connection gets the pre-restart set.
9. **Boot GC of dead entries** — a profile entry naming a session whose
   file left the disk is pruned at boot; the user key survives empty and
   non-fresh.
10. **Residual edge (exercise once, report)** — a user holding a profile
    link with no live observer when another connection rekeys the
    session (`new_session`): does the stale entry survive, and is it
    user-visible? Record, do not fix.

## Tools

- Reused: `tools/manual-test/lib/` (report, sandbox, ws-probe, browser),
  the `agent-browser` skill (mandatory-reuse driver for the PWA journeys).
- New: `tools/manual-test/user-profiles-smoke/` — two-browser + probe
  driver for the journeys above.
- Improved: none.

## Harness Limitations

- Two "devices" are two agent-browser contexts on one host: localStorage
  and sessionStorage isolation are real, so identity, migration seeds,
  and the mirror-clear behavior are exercised for real; network-level
  effects (mobile radios, half-open sockets) are not.
- Sessions are fabricated on disk; no live LLM runs. Session content and
  streaming are outside this tool's scope (covered by the smoke drivers
  that own those journeys). The open/restore/detach/rekey wire paths are
  real.
- The rekey edge is triggered with a wire-level `new_session` rather
  than a user typing `/new` in the PWA — same server-side rekey path
  (`handleSessionReset`), skips only the client's slash interception.
- Boot GC is driven by deleting a session file and restarting, which is
  the real pruning path, but the fixture deletion is synthetic (a real
  deployment deletes via session management).

## Results

Pending — populated after the run.

## Plan Updates

Pending.

## Open Issues

Pending.
