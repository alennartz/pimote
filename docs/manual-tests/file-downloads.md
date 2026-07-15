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

- Reused: `agent-browser` (mandatory browser/PWA driver), direct WebSocket
  probe via the harness, and the server/client unit suites.
- New: `tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs`.
- Improved: none.

## Harness Limitations

The harness uses a real built pimote server, real HTTP download route, real
WebSocket protocol, and headless Chromium through `agent-browser`, but it
fabricates a pi session and invokes the download manager through a small test
extension/HTTP probe rather than a live LLM. Browser download bookkeeping and
OS-level Web Push delivery are not fully observable in headless Chromium; the
harness verifies response headers/body, one-shot HTTP behavior, PWA state and
service-worker intent data instead. It cannot surface real mobile-browser
layout, filesystem-save prompts, cross-device edge authentication, or timing
races between a browser process and a concurrently changing source file. These
limitations weaken visual/mobile and true background-notification coverage, so
those checks are recorded as environment-bounded rather than silently treated
as equivalent to production.

## Results

_To be filled after the smoke suite and topic-specific tests run._

## Plan Updates

_To be filled after the run._

## Open Issues

_To be filled after the run._
