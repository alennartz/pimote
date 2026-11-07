# Manual Testing — hub-member-representation

## Smoke Suite

- **Connect and open a session (journey 1):** Run the dashboard/session portion of `tools/manual-test/project-management-smoke/project-management-smoke.mjs`. This covers folder discovery, opening a folder session, resuming a fabricated session, and returning to the dashboard.
- **Dashboard: folders, hubs, and manager (journey 12):** Run the project-management dashboard and wire smoke. It exercises both hub layouts, persona and code membership edits, session activity, archive/restore, and guarded worktree disband through the dashboard and server seams.
- **Manager folder tools (journey 12 companion):** Run `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` to exercise manager creation, representation-aware membership, activity and state guards, retry-safe disband, and branch preservation.

## Topic-Specific Tests

- **Detached worktree hub creation:** Create a worktree hub through the wire/dashboard flow. Verify the minimal `.pimote-hub.json` marker, detached code checkouts at source `HEAD`, persona symlinks, generated instructions, ignored member names, and unchanged source files.
- **Representation-aware member edits:** Add and remove code and persona members in symlink and worktree hubs. Verify canonical source paths, nested checkout paths, exact managed member lines, source-folder preservation, clean-state removal guards, and marker persistence after the last code worktree is removed.
- **Guarded disband:** Exercise dirty-checkout rejection, observed-session rejection, idle observerless session closure, detached-commit reachability rejection, successful disband after a user branch names the detached commit, branch preservation, registry notification, and retry behavior after partial failure.
- **Dashboard and manager parity:** Confirm dashboard and manager use the same mutation guards and return actionable errors and removal summaries. Confirm symlink hubs have no disband action.
- **Generated-content safety:** Verify disband rejects edited or malformed generated files and unexpected children, does not follow member symlinks, and never removes unrelated source files.

## Tools

- **Reused:** `tools/manual-test/project-management-smoke/project-management-smoke.mjs`.
- **Reused:** `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs`.
- **Reused:** `tools/manual-test/lib/sandbox.mjs`, `lib/ws-probe.mjs`, and `lib/browser.mjs`.
- **Mandatory browser driver:** `agent-browser`, invoked by the project-management smoke through the shared browser helper.
- **New:** None.

## Harness Limitations

The smokes use isolated temporary roots, deterministic Git fixtures, fabricated pi session records, and a local model only when the host exposes the configured `jetson` provider. They do not exercise a real remote repository, real networked LLM, concurrent external pi processes, or a human's browser and filesystem timing. The browser flow uses headless Chromium through `agent-browser`; the wire and manager flows use real server registries and Git commands. The synthetic session and process fixtures weaken coverage of provider latency, OS process-enumeration races, and multi-user contention, but they cover this topic's primary disk-safety, activity-guard, membership, and disband behavior through production seams.

## Results

Pending execution.

## Plan Updates

No persistent-plan changes yet.

## Open Issues

Pending execution.
