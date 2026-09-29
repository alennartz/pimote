# Manual Testing — project-management

## Smoke Suite

The subset of `tools/manual-test/PLAN.md` journeys exercised this run, and why.

1. **Journey 1 — Connect and open a session.** Reshaped by this topic: the
   sidebar is gone, the dashboard is the landing surface, `list_folders` is
   now `list_projects`. Exercised end-to-end: dashboard renders the projects
   list, new session from a project swaps to the session view, back returns
   to the dashboard, resume of a fabricated existing session renders prior
   messages. The active-session dot (`activeSessionCount` enrichment)
   is asserted for a project with a live session.
2. **Journey 2 — Prompt → streamed response (resume half only).** Only the
   settled-state render of a prior conversation is re-run here (via the
   resume in journey 1); the live-streaming core is unchanged by this topic
   and stays covered by its existing drivers (`streaming-code-highlight-smoke`,
   `at-file-syntax-smoke`).

The remaining journeys (extension UI bridge, takeover, slash/tree, panels,
push, voice, Android, provider login, file downloads) are untouched by this
topic per the plan/reviews and the focus hints and are not re-run.

## Topic-Specific Tests

Behaviors specific to this topic that aren't covered by the persistent plan.

- **T1 Dashboard render + search.** Projects list shows every discovered repo
  (single projects) sorted by name; the new-session dialog's search box
  filters client-side. Why: the dashboard is the new product home. Driver:
  `project-management-smoke` (agent-browser).
- **T2 Favorite + manual order.** Star toggles favorite (persisted across
  reload); manage-menu Move up/Move down renumbers explicit `order` values and
  the server's order-then-name sort re-renders. Why: the "flat alphabetized
  dump" pain is the feature's headline UX fix. Driver: smoke (agent-browser +
  WS probe of the persisted registry).
- **T3 Archive.** Archive project → "Archived" badge, hidden unless
  show-archived is on; unarchive restores. Why: soft-hide of finished
  projects. Driver: smoke.
- **T4 Hub creation (symlinks + AGENTS.md).** Manage-menu hub dialog: name +
  root + member picker (fed by `list_repos`, showing branch/dirty) → hub
  listed as `multi` with member chips; on disk: hub folder under the chosen
  root, one symlink per member (absolute targets), generated AGENTS.md naming
  each member and the sub-project convention. Why: the multi-repo model is
  the reason the feature exists. Driver: smoke (agent-browser + direct fs
  assertions).
- **T5 Disband.** Confirm dialog → project removed, hub folder deleted,
  member repos untouched on disk. Driver: smoke.
- **T6 Manager chat.** Prompt → streamed assistant response renders in the
  manager pane (real LLM); tool-use prompt ("how many projects… use
  pimote_list_projects") renders a tool call and a correct answer; while
  working, Send swaps to Abort and aborting returns to idle; a page reload
  (fresh connection) finds an empty transcript (ephemeral per connection).
  Why: the manager is the dashboard's second half. Driver: smoke
  (agent-browser; real model via copied credentials).
- **T7 `projects_changed` sync across two clients.** A WebSocket probe client
  (second "device") receives `projects_changed` after the browser favorites a
  project; a mutation from the probe updates the browser's list without a
  reload. Why: multi-device consistency is the documented update path. Driver:
  smoke (WS probe + agent-browser).
- **T8 Repo chips + nested discovery.** Hub member chips render repo name +
  branch + dirty dot (one fixture repo dirty, one clean, named branches);
  repos nested two and three levels below a configured root appear in the
  projects list. Why: deeper-than-one-level discovery was the primary pain.
  Driver: smoke.
- **T9 Create project (mkdir + git init).** Preserved sidebar feature through
  the new dialog: create → appears in the list, `.git` exists on disk. Driver:
  smoke.
- **T10 Missing-member chip.** Delete a hub member repo on disk, restart the
  server (fresh TTL), reload: the member chip renders in the warning style
  with "missing". Why: the `missing` surface keeps projects editable after
  disk changes. Driver: smoke.

## Tools

- Reused: `agent-browser` skill/CLI (mandatory-reuse driver for the PWA
  surface); direct WebSocket probes via Node's built-in `WebSocket` (HTTP/WS
  domain); the sandbox-boot harness pattern shared with
  `update-notification-smoke` / `at-file-syntax-smoke`.
- New: `tools/manual-test/project-management-smoke/` — boots a real pimote
  server in an isolated HOME against a fabricated multi-root project tree
  (nested repos, dirty repo, named branches, fabricated pi session jsonl),
  seeds real credentials via `PI_CODING_AGENT_DIR` for the manager LLM, and
  drives the dashboard via `agent-browser` plus a second WebSocket probe
  client. Registered in `tools/manual-test/README.md`.
- Improved: none this run.

## Harness Limitations

- **Manager LLM is real, not stubbed.** The harness copies the host's
  `models.json` into the sandbox agent dir (`PI_CODING_AGENT_DIR`) and
  defaults to the local `jetson` provider (no credentials involved), so the
  manager session runs a real model. If the model endpoint is unreachable,
  T6's streamed response degrades to environment-bounded rather than failing
  silently — this is reported per-run. There is no structural gap: the real
  streaming path is what runs.
- **Model nondeterminism in T6.** The tool-use prompt depends on the model
  choosing `pimote_list_projects`; the prompt is phrased to force it, but a
  non-call is a soft finding (re-check with a more explicit prompt), not
  automatically a product bug.
- **Sessions are disk-fabricated** under the sandbox agent dir's `sessions/`
  (the real `SessionManager` rehydration path, chained via `parentId` like
  real pi sessions); content is synthetic but the render path is real.
- **Two clients = browser + WS probe.** Both are real clients of the real
  server; neither is a second _browser profile_, so browser-only surfaces
  (e.g. reconnect backoff) aren't double-exercised.
- **Repo-index TTL (30s) vs. fresh discovery.** Tests that need fresh
  discovery after on-disk mutations restart the server instead of waiting out
  the TTL; the TTL itself is unit-tested.

## Results

Run: `PM_SHOTS=/tmp/pm-shots node tools/manual-test/project-management-smoke/project-management-smoke.mjs` —
85 checks, 0 failures, exit 0. Coherence screenshots in `/tmp/pm-shots/`.

### Smoke Suite

- **Journey 1 (dashboard half)** — pass. Dashboard renders all discovered
  projects (depth-1/2/3), new-session dialog opens a session (composer +
  StatusBar), closing the viewed chip returns to the dashboard, resume of the
  fabricated session renders both prior messages, active-session dot lights
  for a session opened by another client. **Looks coherent** (01-dashboard.png,
  03-resume.png): projects column + manager side-by-side matches the
  brainstorm's two-surface design. Cosmetic nit: empty projects show both a
  "No sessions" row subtitle and a "No sessions yet" expanded line.
- **Journey 2 (resume half)** — pass (see above). Live-streaming core not
  re-run (unchanged surface; existing drivers own it).

### Topic-Specific Tests

| #   | Test                                | Verdict                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Dashboard render + search           | pass — lists every repo, filters client-side; **looks coherent**                                                                                                                                                                                                           |
| T2  | Favorite + manual order             | pass — star toggles + survives reload; move-up reorders to top, persists; **looks coherent**                                                                                                                                                                               |
| T3  | Archive / show-archived             | pass — badge + hide/reveal cycle; **looks coherent** (04-archived.png)                                                                                                                                                                                                     |
| T4  | Hub creation (symlinks + AGENTS.md) | pass — UI dialog and WS both; disk: absolute symlinks + AGENTS.md naming members; **looks coherent** (05-hub-dialog.png)                                                                                                                                                   |
| T5  | Disband                             | pass — UI confirm + WS; hub folder deleted, members intact; single-repo refusal                                                                                                                                                                                            |
| T6  | Manager chat                        | pass — live streamed reply (PONG), `pimote_list_projects` tool call rendered through real ports, correct count answer (7), abort freezes the stream and returns to idle, transcript empty on fresh connection; **looks coherent** (07/08: thought blocks, tool row, reply) |
| T7  | `projects_changed` two-client sync  | pass — both directions: probe→probe event, probe→browser live re-render, browser→probe event                                                                                                                                                                               |
| T8  | Repo chips + nested discovery       | pass — branch names (main, feature/zebra), dirty dot on beta, clean dots elsewhere, hub (folder-git) icon; depth-4 excluded; **looks coherent** (06-hub-chips.png)                                                                                                         |
| T9  | Create project (mkdir + git init)   | pass — dialog flow opens the new session, project listed, `.git` on disk                                                                                                                                                                                                   |
| T10 | Missing-member chip                 | pass — "beta missing" warning chip after disk deletion + restart; **looks coherent** (09-missing-chip.png)                                                                                                                                                                 |
| —   | Mobile dashboard + manager sheet    | pass — fullscreen list, fixed Manager affordance, sheet with composer; **looks coherent** (10-mobile-manager.png)                                                                                                                                                          |

No product bugs found. All 12 failures observed during bring-up were harness
bugs (wrong fixture encoding, placeholder-vs-innerText assertions, substring
target collisions), fixed in the tool inline — none touched product code.

## Plan Updates

- **Added journey 12 — Dashboard: projects, hubs, and manager** to
  `tools/manual-test/PLAN.md`, driven by `project-management-smoke`.
- **Modified journey 1** — `list_folders`/sidebar wording replaced with the
  dashboard shape; its driver upgraded from manual-browser to
  `project-management-smoke` for the dashboard half.
- Automation-gap note updated accordingly.

## Open Issues

- **Pre-existing, other topics' tools: stale pi session-dir encoding.** The
  pi SDK now encodes per-cwd session dirs with a trailing `--`
  (`--<encoded-cwd>--`); `update-notification-smoke`, `cost-accumulation-smoke`,
  and other smokes seed fixtures under the old encoding (no trailing `--`) and
  target `$HOME/.pi/agent/sessions`, so their fabricated sessions no longer
  list. Their next runs will fail (or silently test less) until re-pointed.
  Out of scope for this topic; flagged for the maintainers of those tools.
