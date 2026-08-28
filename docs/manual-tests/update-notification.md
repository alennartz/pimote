# Manual Testing — update-notification

## Smoke Suite

- **Connect and open a session (journey 1):** exercise the real PWA landing/session connection path while observing the update notification surfaces. This is the adjacent primary journey because update status is delivered on accepted WebSocket connections and the settings/status markers live in the connected session UI. Driver: `agent-browser` against a sandboxed pimote instance.

Unchanged prompt, voice, panel, and other session journeys are deliberately out of scope for this feature run; their existing persistent smoke coverage remains authoritative.

## Topic-Specific Tests

- **Deterministic enabled update:** seed the server's npm-registry seam with a controlled newer version and verify an accepted WebSocket receives `update_available`, the PWA banner shows current/latest versions and the supplied release link, and the layout is coherent at mobile and desktop widths. Driver: a parameterized/manual sandbox harness using the real server and `agent-browser`.
- **Dismiss to ambient:** dismiss the banner and verify the banner disappears while the mobile settings-gear dot, SessionSettingsDialog row, and desktop StatusBar item remain. Driver: `agent-browser`.
- **Persistence and newer release:** verify `pimote:dismissedUpdateVersion` survives reload/reconnect, and a later newer latest version shows the banner again. Driver: `agent-browser` plus controlled server state.
- **Banner-slot coexistence:** verify the update banner does not displace or overlap the existing install/notification banner slot at approximately 360px width. Driver: `agent-browser` screenshot/coherence pass.
- **Disabled path:** configure `updateCheck: false`, verify no registry request is made and no update event/banner/ambient marker appears. Driver: sandbox server log + `agent-browser`.
- **Equal/older registry response:** verify deterministic equal and older versions produce no status or client surfaces. Driver: direct WebSocket probe + `agent-browser`.

## Tools

- Reused: `agent-browser` skill; direct WebSocket probe via shell where needed; existing build/test commands.
- New: none planned initially. A small reusable harness may be added under `tools/manual-test/update-notification-smoke/` only if the existing tools cannot drive deterministic registry responses.
- Improved: none.

## Harness Limitations

The real npm registry is not used; the test must inject or otherwise control the registry response so it does not depend on a currently published newer version. The sandbox uses a single local server/browser and synthetic registry responses, so it cannot expose multi-host load behavior, real proxy/registry latency, or cross-device localStorage synchronization. These gaps do not weaken the primary update banner, dismissal, persistence, marker, or disabled-path behaviors when the local fixture can observe requests and reconnects.

## Results

_To be filled after execution._

## Plan Updates

Empty — update notification is a topic-specific addition to the existing connect/open-session journey, not a new primary journey.

## Open Issues

_To be filled after execution._
