# Manual Testing — client-themes

## Smoke Suite

- **Connect and open a session (journey 1):** boot an isolated server and open the PWA. This confirms the browser path and server connection needed by Appearance.
- **Global Settings and folder instructions (journey 13):** open Settings on desktop and mobile, use the Appearance tab, and verify its shared dialog controls.
- **One user, many devices (journey 14):** use two isolated browser connections with one Pimote username. Save a theme on one connection and verify the other connection adopts it.

The topic focus narrows this run to the settings and same-user theme paths, plus the optional static-report helper. Other persistent journeys remain covered by their existing drivers.

## Topic-Specific Tests

- **Approved desktop Appearance flow:** open Appearance, inspect the paired UI/code previews, select built-in themes, verify local palette preview and status, use Save, and use Cancel to restore the saved selection.
- **Approved mobile Appearance flow:** set a narrow viewport, select a theme, verify header Save and Close controls, verify Close cancels an unsaved preview, and verify Save persists it.
- **Follow server default:** select Follow server default, verify the active palette resolves to the configured default, save it, and verify the choice follows the server default rather than a fixed theme override.
- **Report helper:** serve a report bundle through static-host, load the optional `/pwa/theme-bridge.js` helper, verify a user-scoped cached theme is applied, verify no cache leaves report fallback styles unchanged, and verify the helper reacts to user/cache storage changes and stops cleanly.
- **Verbatim static-host serving:** compare bytes for the authored report bundle before and after serving it. Confirm static-host does not rewrite the bundle or require the helper.

## Tools

- Reused: `tools/manual-test/lib/sandbox.mjs`, `tools/manual-test/lib/browser.mjs`, `tools/manual-test/lib/ws-probe.mjs`, and the `agent-browser` skill.
- New: `tools/manual-test/client-themes-smoke/client-themes-smoke.mjs` for the isolated server, two browser connections, and report-helper checks.
- Improved: none.

## Harness Limitations

The server, WebSocket protocol, PWA, and static-host route run in an isolated temporary HOME and configuration directory. The browser driver uses Chromium through `agent-browser`, not a physical mobile browser, so the mobile check verifies the responsive mobile viewport and controls but not iOS/Android browser chrome. The same-user check uses two browser connections and deterministic saved sessions, not two real devices. The report helper check uses a synthetic static bundle and browser storage events; it does not exercise a deployed reverse proxy or a report's application-specific CSS. No user persistent theme/config, live session, or host static bundle is touched.

## Results

_To be filled after execution._

## Plan Updates

Empty. The topic-specific flows do not add or retire a primary journey.

## Open Issues

_To be filled after execution._
