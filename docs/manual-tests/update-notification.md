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
- New: `tools/manual-test/update-notification-smoke/` (`update-notification-smoke.mjs` plus `fake-registry.mjs`) — deterministic server/PWA harness with a controlled registry seam.
- Improved: none.

## Harness Limitations

The real npm registry is not used: `fake-registry.mjs` intercepts only the fixed npm latest-version URL in the child server process, so all version scenarios are deterministic. The sandbox uses one local server/browser and synthetic registry responses; it cannot expose multi-host load behavior, real proxy/registry latency, or cross-device localStorage synchronization. Headless Chromium in this environment does not expose a usable PushManager/service worker, so the permission-gated `NotificationBanner` could not be rendered directly. The run dispatched a real `beforeinstallprompt` event to render the sibling `InstallBanner` and inspect simultaneous top/bottom banner geometry instead; the screenshot therefore covers slot separation, but not Push-specific notification copy/icon rendering. These gaps do not weaken the update event, banner, dismissal, persistence, marker, newer-release, equal/older, or disabled-path checks.

## Results

### Smoke Suite

- **Connect and open a session — pass.** `update-notification-smoke.mjs` booted a fresh server, connected the PWA with `agent-browser`, opened the seeded session, and observed the settings marker/detail surfaces. **Coherence:** looks coherent; the update notice is global on the landing view and the detail follows the active session without disturbing the empty session state.

### Topic-Specific Tests

- **Deterministic enabled update — pass.** A preloaded fetch seam returned `999.0.0`; one startup/connection single-flight request produced the exact `update_available` payload and canonical release URL, and the PWA displayed both versions. **Coherence:** looks coherent; at 360px the copy wraps cleanly and the action/dismiss controls remain usable.
- **Dismiss to ambient — pass.** Clicking the snapshot-exposed accessible dismiss control removed the banner, persisted `pimote:dismissedUpdateVersion`, and left the mobile gear dot, SessionSettingsDialog row/link, and desktop StatusBar item visible. **Coherence:** looks coherent; interruption becomes low-key detail rather than disappearing.
- **Persistence and newer release — pass.** Reload and a server restart/reconnect kept the same-version banner hidden; changing the controlled latest version to `999.1.0` raised the banner again without overwriting the prior dismissal until dismissed. **Coherence:** looks coherent; the version-keyed behavior matches the intended reminder lifecycle.
- **Banner-slot coexistence/layout — pass (with limitation above).** At 360×760, the update banner rendered at the top while a synthetic real `InstallBanner` rendered independently at the bottom; desktop 1280×900 showed a compact StatusBar item. **Coherence:** looks coherent; no overlap or competing same-slot layout was visible. Push `NotificationBanner` itself was environment-limited.
- **Disabled path — pass.** With `updateCheck: false`, the controlled registry fetch count did not increase and reload showed no banner, desktop item, or mobile gear dot. **Coherence:** looks coherent; opting out leaves the existing session chrome unchanged.
- **Equal/older registry response — pass.** Controlled equal (`0.11.0`) and older (`0.0.0`) responses produced no `update_available` event. **Coherence:** looks coherent; no false-positive notification surface appears for a current or ahead-of-registry server.

## Plan Updates

Empty — the topic adds update state to the existing connect/open-session journey rather than a new primary journey.

## Open Issues

Empty. The PushManager/service-worker limitation is recorded above; the InstallBanner substitute covered the shared mobile slot geometry without falsifying a Push capability.
