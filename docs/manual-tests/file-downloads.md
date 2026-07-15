# Manual Testing — file-downloads

## Smoke Suite

This run is scoped to the PWA entry and notification journeys adjacent to
file downloads. It exercises connecting to a sandboxed server and opening a
session (the prerequisite for the download UI), plus the new file-download
journey and its notification/reconnect behavior. Unchanged Android, voice,
and unrelated extension surfaces are deliberately out of scope for this run.

- Connect and open a session — bootstrap prerequisite; driven by the new
  `file-downloads-smoke` browser harness.
- File offer → native download / fallback inbox — primary journey introduced by
  this topic; driven by the new `file-downloads-smoke` harness and
  `agent-browser`.
- Push notification handling for a pending download — adjacent existing
  notification journey; driven by the deterministic client push-planning seam
  in the same harness where browser notification APIs permit.

## Topic-Specific Tests

- Offered toast shows the exact offered item from a multi-item snapshot and its
  one-click native link.
- Clicking the native link consumes the registration exactly once, preserves
  the source file, and removes the pending item from the live PWA state.
- Missing the toast leaves the item in the viewed session's compact inbox;
  multiple pending files remain session-local and do not appear in another
  session.
- A reconnect/reopen restores pending registrations silently (no duplicate
  toast), and a consumed/revoked update does not leave a stale actionable toast.
- A background push exposes only an `openDownloads` inbox intent; it never
  follows the one-shot download URL. Focused-client notification suppression is
  checked where the browser environment exposes a usable push seam.

## Tools

- Reused: `agent-browser` (mandatory browser/PWA driver) and the
  server/client unit suites; the harness exercises the real WebSocket protocol
  through the PWA connection.
- New: `tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs`.
- Improved: none.

## Harness Limitations

The harness uses a real built pimote server, real HTTP download route, real
WebSocket protocol, and headless Chromium through `agent-browser`, but it
fabricates a pi session and emits the typed offer through a small sandbox test
extension rather than a live LLM/tool turn. Browser download bookkeeping and
OS-level Web Push delivery are not fully observable in headless Chromium; the
harness verifies response headers/body, one-shot HTTP behavior, and PWA state,
while the client unit suite verifies service-worker intent data. It cannot
surface real mobile-browser
layout, filesystem-save prompts, cross-device edge authentication, or timing
races between a browser process and a concurrently changing source file. These
limitations weaken visual/mobile and true background-notification coverage, so
those checks are recorded as environment-bounded rather than silently treated
as equivalent to production.

## Results

### Smoke Suite

- **Connect and open a session — pass.** Ran
  `node tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs`.
  The real PWA connected to a sandboxed server, listed both seeded projects,
  and opened the owner session. The session view and Downloads status affordance
  are coherent: the owner context, pending count, and normal chat input share
  the same compact status bar without obscuring the conversation.
- **File offer → native download / fallback inbox — pass.** The same harness
  observed an exact-item offered toast, dismissed it, opened the two-item
  session-local inbox, downloaded `offer.txt` through the native browser
  attachment path, verified the live bytes, and observed a consumed snapshot.
  The UI is coherent: the toast is concise and actionable, while the inbox
  preserves the same filename/size/link vocabulary and visible pending count.
- **Push notification handling — pass (deterministic seam), environment-bounded
  for OS delivery.** Ran the focused client push-planner and notification-intent
  tests below; they enforce no href in background data and switch/adopt-then-open
  ordering. Headless Chromium had no real VAPID subscription/OS notification
  surface, so an actual background notification click was not claimed as a
  browser pass.

### Topic-Specific Tests

- **Exact offered item in a multi-item snapshot — pass.** The harness emitted a
  two-item full snapshot with `offeredDownloadId` pointing at `offer.txt`; the
  toast named `offer.txt` and its link was `/d/manual-download-offer-001`, not
  the other pending file.
- **One-shot consumption and source preservation — pass.** `agent-browser
download 'a[href="/d/manual-download-offer-001"]:visible' ...` saved the
  expected bytes; the source file remained present; the persisted document
  retained only the sibling registration; a second HTTP request returned 404.
- **Session-local fallback inbox — pass.** Dismissing the toast exposed both
  native links only in the owner session. Switching to the other seeded session
  removed the Downloads affordance; switching back restored the one surviving
  pending count.
- **Reconnect/reopen recovery — pass.** The harness stopped and restarted the
  real server with offer synthesis disabled, reopened the PWA, and found the
  surviving pending registration. The restored snapshot was silent (no stale
  or duplicate actionable toast), and the consumed id remained unavailable.
- **Focused/background notification planning — pass at pure seam.**
  `npm test --workspace=client -- --run
src/lib/download-presentation.test.ts src/lib/download-coordinator.test.ts
src/lib/download-push.test.ts src/lib/download-notification-intent.test.ts
src/lib/stores/session-registry.test.ts` — 5 files, 100 tests passed. The
  background planner and inbox intent tests verify focused deduplication,
  presentation-only metadata, no href, and existing/adopt-then-open behavior.

Supporting server boundary suite:
`npm test --workspace=@pimote/server -- --run
src/file-download/manager.test.ts src/file-download/http-handler.test.ts
src/file-download/index.test.ts src/file-download/bootstrap.test.ts
src/session-manager.test.ts src/ws-handler.test.ts src/push-notification.test.ts`
— 7 files, 163 tests passed.

## Plan Updates

Added primary journey 11, **File offer → native download / session inbox**, to
`tools/manual-test/PLAN.md`. It records the new `file-downloads-smoke` driver
and the environment-bound OS Web Push limitation. Existing journeys were not
changed.

## Open Issues

- A real background OS notification click was not exercised: this headless
  environment has no configured VAPID subscription/notification permission
  surface. The focused client planner and notification-intent contracts pass;
  run the same journey in an installed/real browser with push permission before
  release if OS delivery is the release gate.
