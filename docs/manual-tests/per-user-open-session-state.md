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
5. **Settings User pane: mobile header Save** — below the mobile
   breakpoint the dialog header carries Save; saving from it reconnects
   to the new profile.
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
  the `agent-browser` skill (mandatory-reuse driver for the PWA journeys —
  proven via snapshot → `Open Settings` click and the entry/button clicks
  in `user-profiles-smoke`).
- New: `tools/manual-test/user-profiles-smoke/` — two-browser + probe
  driver for the journeys above; registered in `tools/manual-test/README.md`.
- Improved: `lib/ws-probe.mjs` gained an optional `user` constructor
  argument for `?user=` connections (defaults to the server's `default`).

## Harness Limitations

- Two "devices" are two agent-browser contexts on one host: localStorage
  and sessionStorage isolation are real, so identity, migration seeds,
  and the mirror-clear behavior are exercised for real; network-level
  effects (mobile radios, half-open sockets) are not.
- Sessions are fabricated on disk; no live LLM runs in this tool. The
  open/restore/detach/rekey wire paths are real; content rendering is
  owned by the smoke drivers listed in the suite above.
- The rekey edge is triggered with a wire-level `new_session` rather
  than a user typing `/new` in the PWA — same server-side rekey path
  (`handleSessionReset`), skips only the client's slash interception.
- Boot GC is driven by deleting a session file and restarting, which is
  the real pruning path, but the fixture deletion is synthetic (a real
  deployment deletes via session management).
- The local model endpoint is unreachable in this environment, so the
  observers smoke's run-dependent assertions (queue order under an
  in-flight run, replay past a settled turn) run environment-bounded.

## Results

### Smoke Suite

- **J1/J12 — `project-management-smoke`** — core loop passes at HEAD:
  unscanned-cwd opens, session view mount, `Close session` (now
  `detach_session`) returns to the dashboard, the cross-client
  active-session dot, warm-cache navigation (181 ✓). Verdict: **looks
  coherent** for the loop half. 34 assertions fail — source fixtures,
  favorites, tags, wizard, hub dialog, chips — all folder-model/dashboard
  surfaces this diff never touches; the same failure classes reproduce at
  the pre-topic commit (98b74fd, worktree run) and the baseline crashes
  even earlier on the stale `session_opened` pattern. Driver drift, not a
  regression → open issue. **open** (driver refresh, not this topic).
- **J2 — `streaming-code-highlight-smoke`** — **fixed-inline** twice:
  (1) the dashboard row now starts half-open, so the driver expands the
  row before finding the session entry; (2) write blocks auto-collapse
  when fully scrolled out of view (a deliberate behavior added after the
  smoke was written), so the finder scrolls each block into view, settles
  the observer, and expands before asserting. PASS (19 ✓). Verdict:
  **looks coherent**.
- **J2 — `at-file-syntax-smoke`** — **fixed-inline**: the fd-missing
  phase now mirrors the server's real fd search (PATH + the fallback dirs
  `fdSearchDirs` probes); on this host fd lives in `~/.pi/agent/bin`, so
  that phase reports environment-bounded instead of failing. The
  prompt-composition phase seeds the host model catalog so pi's preflight
  accepts the send. PASS (29 ✓, 1 environment-bounded). Verdict: **looks
  coherent**.
- **J4 — `session-observers-smoke`** — **fixed-inline**: the model-catalog
  gate no longer keys on the retired `jetson` provider name, and the two
  run-dependent assertions respect endpoint reachability (unreachable →
  environment-bounded). PASS (34 ✓, 2 environment-bounded). The
  stale-localStorage boot path and archive/detach fan-out — this topic's
  surfaces — pass hard. Verdict: **looks coherent**.
- **J12 — `manager-lifecycle-smoke`** — **fixed-inline**: the manager-root
  classification assertion reads the open response's `folder` (the
  acting-client contract since 8832b5b) instead of waiting for a
  `session_opened` echo the server no longer sends. PASS (38 ✓).
  Verdict: **looks coherent** (wire-level journey).
- **J13 — `agents-md-editor-smoke`** — PASS as-is (38 ✓). The User tab
  shares this dialog shell; no regression. Verdict: **looks coherent**.
- **pimote-in-pimote loop not disrupted** — every driver boots its own
  sandboxed server (own HOME/XDG dirs, tracked child PID); the production
  service was never restarted and answers `/health` before and after the
  run. Verdict: **pass**.

### Topic-Specific (all from `user-profiles-smoke`, 62 hard assertions, 0 failures)

1. Shared set across a user's browsers — **pass**; two browsers on one
   user: an open on device A lights device B's dashboard entry; B's own
   close drops it from both; **looks coherent** (per the approved mock's
   same-user sharing copy).
2. Cross-user isolation — **pass**; bob's link and live subscription
   survive alice's detach; bob receives no alice broadcast.
3. Settings User pane: chip adopt (desktop) — **pass**; counts (alice
   0, bob 1), current marker, adopt fills the input, dirty marker +
   `Unsaved changes` hint, known-profile consequence copy, footer Save
   enables, save persists + reconnects to the adopted profile's set,
   chips refresh and re-mark current; **looks coherent** against the
   approved mock.
4. Rename to a brand-new user — **pass**; unknown-profile consequence
   copy ("starts empty"), switch reconnects, the device's list starts
   empty, and no server key is created until a session opens.
5. Mobile header Save — **pass**; at 390 px the header carries an enabled
   Save, the footer Save is absent, saving switches the device and loads
   the adopted profile's set; **looks coherent** (adaptive chrome per
   mock/`CodeEditorDialog`).
6. Migration adopt-once — **pass**; a fresh profile adopts the seeded
   local set (opened server-side, profile count 1) and the mirror clears.
7. Stale second browser — **pass**; with profile truth `[adoptId]`, a
   browser seeding `[adoptId, staleId]` never opens the stale extra and
   the profile stays at 1; **the closed session does not resurrect**.
8. Restart survival — **pass**; dave's and bob's profiles replay intact
   after a full stop/start.
9. Boot GC — **pass**; a deleted session's entry is pruned at boot; the
   empty key stays and is non-fresh; `default`/`carol` keys never appear.
10. Residual rekey edge — **open** (see below).

Fixed-inline commits (for cleanup's DR consideration):
`fix: smoke drivers follow the acting-client open contract`,
`fix: session-observers smoke respects model-endpoint reachability`,
`fix: streaming-highlight smoke respects write-block auto-collapse`,
`fix: at-file smoke mirrors server fd search and seeds model catalog`.
All four repair smoke drivers that predate shipped behavior changes
(acting-client open contract, model-catalog rename, dashboard expander +
write-block auto-collapse, fd fallback-dir probing) — none touches app
code.

## Plan Updates

- **Added journey 14** — "One user, many devices: the shared open-session
  set" — the topic's headline path, driven by
  `tools/manual-test/user-profiles-smoke/`.
- Journey 13's entry now names the User tab within the Settings shell.
- `tools/manual-test/README.md` registers the new tool and the ws-probe
  `user` argument.

## Open Issues

1. **Residual edge, confirmed user-visible (recorded, not fixed per task
   scope).** A user holding a profile link with NO live observer at the
   moment another connection rekeys that session keeps the stale
   pre-rekey entry. `relinkSessionForUser` only moves the resetting
   connection's user; `handleSessionReset` runs per observer, and a user
   with no observer is absent from that loop. Reproduced: erin links S1
   and disconnects; bob's live connection rekeys S1 → S1′ (pi `/new`
   path); erin's profile still names S1. On her next connect the client
   opens S1 successfully — **her device restores the abandoned pre-reset
   transcript as a live session while the rekeyed S1′ is absent from her
   set**. Boot GC will not prune S1 while the pre-reset file exists on
   disk (pi keeps it), so the churn variant (failed opens retrying every
   reconnect) or the stale-transcript variant persists indefinitely.
   Server-side shape of a fix, for the cleanup phase to consider: on the
   `rekeyed` outcome, `unlinkAll(oldId)` + `link` for every affected user
   (the per-user mirror of `relinkSessionForUser`), broadcasting to each.
2. **`project-management-smoke` driver refresh (pre-existing, out of
   scope).** 34 assertions fail against the redesigned dashboard and
   evolved folder model (source fixtures, favorites, tags, wizard, hub
   dialog, chips, multiRepo). The same classes fail at the pre-topic
   commit, which also crashes earlier on the stale
   `session_opened`-echo pattern fixed this run. The loop-relevant half
   (open/close/dot/unscanned cwds) passes. Refreshing this driver is a
   topic-sized effort of its own.
3. **fd-missing smoke phase is structurally unreachable on hosts where
   fd lives in a probed fallback dir** (e.g. `~/.pi/agent/bin`). The
   phase now reports environment-bounded there; a future revision could
   inject a fake minimal PATH environment the server cannot escape.
