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

- **Manager LLM is real, not stubbed.** The harness copies the deployment's
  `auth.json`/`models.json` into the sandbox agent dir so the manager session
  runs a real model. If the provider endpoint is unreachable, T6's streamed
  response degrades to environment-bounded rather than failing silently —
  this is reported per-run. There is no structural gap: the real streaming
  path is what runs.
- **Model nondeterminism in T6.** The tool-use prompt depends on the model
  choosing `pimote_list_projects`; the prompt is phrased to force it, but a
  non-call is a soft finding (re-check with a more explicit prompt), not
  automatically a product bug.
- **Sessions are disk-fabricated.** Resume renders the real
  `SessionManager` rehydration of a fabricated jsonl (same as prior smokes);
  content is synthetic but the render path is real.
- **Two clients = browser + WS probe.** Both are real clients of the real
  server; neither is a second _browser profile_, so browser-only surfaces
  (e.g. reconnect backoff) aren't double-exercised.
- **Repo-index TTL (30s) vs. fresh discovery.** Tests that need fresh
  discovery after on-disk mutations restart the server instead of waiting out
  the TTL; the TTL itself is unit-tested.

## Results

_Filled in after execution._

## Plan Updates

_Filled in after execution._

## Open Issues

_Filled in after execution._
