# Manual Testing — hub-member-representation

## Smoke Suite

- **Connect and open a session (journey 1):** `project-management-smoke` opened new code, persona, and hub sessions, resumed a fabricated session, and returned to the dashboard.
- **Dashboard: folders, hubs, and manager (journey 12):** `project-management-smoke` exercised dashboard creation, member management, worktree disband, curation, and wire synchronization. The manager-chat parts that require `jetson` were environment-bounded.
- **Manager folder tools (journey 12 companion):** `manager-tools-smoke` exercised the nine-tool registration and manager creation, membership, activity, guard, generated-content, and retry paths without an LLM.

## Topic-Specific Tests

- **Detached worktree hub creation:** Create worktree hubs through the wire, dashboard, and manager seams. Verify the minimal `.pimote-hub.json` marker, detached code checkouts at source `HEAD`, persona symlinks, generated instructions, ignored member names, and unchanged source files.
- **Representation-aware member edits:** Add and remove code and persona members in symlink and worktree hubs. Verify canonical source paths, nested checkout paths, exact managed member lines, source-folder preservation, clean-state removal guards, and marker persistence after the last code worktree is removed.
- **Guarded disband:** Exercise dirty-checkout rejection, observed-session rejection, idle observerless session closure, detached-commit reachability rejection, successful disband after a user branch names the detached commit, branch preservation, registry notification, and retry-safe dashboard behavior.
- **Dashboard and manager parity:** Confirm dashboard and manager use the same mutation guards and return actionable errors and removal summaries. Confirm symlink hubs have no disband action.
- **Generated-content safety:** Edit generated instructions while Git ignores them and add an unexpected child. Verify disband rejects both, keeps the hub and source user files, and never follows persona symlinks.
- **Partial-failure retry:** Inject one Git removal failure after an earlier checkout removal. Verify the surviving checkout remains discoverable, generated ignore state is reconciled, and a retry removes only the remaining checkout and hub without stale Git metadata.

## Tools

- **Reused:** `tools/manual-test/project-management-smoke/project-management-smoke.mjs`.
- **Reused and improved:** `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` now covers generated-content safety and partial-removal retry through a real registry and Git adapter.
- **Reused:** `tools/manual-test/lib/sandbox.mjs`, `lib/ws-probe.mjs`, and `lib/browser.mjs`.
- **Mandatory browser driver:** `agent-browser`, invoked by the project-management smoke through the shared browser helper.
- **New:** None.

## Harness Limitations

The smokes use isolated temporary roots, deterministic Git fixtures, fabricated pi session records, and a local model only when the host exposes the configured `jetson` provider. The browser flow uses headless Chromium through `agent-browser`; the wire and manager flows use real server registries and Git commands. The partial-failure case injects a deterministic adapter failure rather than a real disk or process fault. The runs do not exercise a real remote repository, networked LLM, concurrent external pi processes, or human filesystem timing. These gaps weaken provider-latency, OS process-enumeration race, and multi-user contention coverage, but they do not weaken this topic's primary disk-safety, activity-guard, membership, generated-content, and retry assertions.

## Results

- **Connect and open a session — pass.** `PM_SHOTS=/tmp/hub-member-pm-shots PM_KEEP=1 node tools/manual-test/project-management-smoke/project-management-smoke.mjs` opened code, persona, symlink-hub, persona-hub, and worktree-hub sessions, resumed the fabricated alpha session, and returned to the dashboard. The dashboard and session surfaces looked coherent.
- **Dashboard hub journey — pass.** The same run verified symlink and detached-worktree creation, representation-aware member add/remove, dashboard disband dialog, dirty and observed-session rejection, idle-session closure, branch reachability, `folders_changed`, archive/restore, and source preservation. Screenshots looked coherent: hub rows, member chips, dirty indicators, and missing-member warnings matched the surrounding dashboard.
- **Manager toolset and lifecycle — pass.** `node tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` registered exactly nine tools and passed all creation, membership, clean-state, activity, disband, branch-preservation, and folder-listing checks. Its generated-content and partial-retry extensions also passed.
- **Dashboard and manager parity — pass.** Both surfaces used the same registry guards. Symlink hubs exposed no disband action. Worktree disband returned the removed checkout path and removed the hub row.
- **Generated-content safety — pass.** The manager smoke rejected an unexpected hub child and edited `AGENTS.md` even when Git ignored it. It kept the hub, persona source, and unrelated source file intact. Restoring generated content allowed safe disband.
- **Partial-failure retry — pass.** The manager smoke reported an injected second-worktree removal failure, kept the remaining checkout discoverable, reconciled the shape, and succeeded on retry without stale Git worktree metadata.
- **Automated contract checks — pass.** `npm run test --workspace=@pimote/server -- --run src/folder-registry-worktree.test.ts src/hub-worktrees.test.ts src/hub-activity.test.ts src/manager/extension.test.ts src/ws-folder-commands.test.ts src/ws-handler.test.ts` passed 339 tests. The three focused client suites passed 15 tests.
- **Inline fix — fixed-inline.** The first manager smoke exposed two localized issues: `removeMember` and partial disband assumed `evictStatus` existed on a narrow test seam, and the marker rejection text did not include the dashboard's expected `Not a worktree hub` phrase. Optional eviction and a combined user-facing error fixed both. The final manager smoke and focused suites passed.
- **Environment-bounded manager chat — pass with limitation.** The project-management smoke reported four non-failing bounded items because this host has no `jetson` provider and the disconnected local-model count run was slow. Deterministic manager tools covered the topic's manager contract without an LLM.

## Plan Updates

- Extended the existing manager smoke driver and README to cover generated-content rejection, unrelated-file preservation, and partial disband retry. No new primary journey was added; journey 12 already names this topic's dashboard and manager surfaces.

## Open Issues

- No product issues remain from the exercised topic flows. Provider-backed manager chat and realistic external-process timing remain outside this host's environment.
