# Manual Testing — static-resources

## Smoke Suite

Topic scope is server-side static hosting + a single new `Card.href`
field. The whole repo Smoke Suite (journeys 1–9) is out of scope for
this run — none of those journeys are reshaped by static-resources and
running them adds nothing over their last topic's verification.

The single journey-level smoke pulled in here is **journey 6 (Panel
cards from extensions)**, because it's the surface the new `href` flows
into. It's exercised as part of the topic-specific tests below; no
standalone re-run.

## Topic-Specific Tests

All driven by the new `static-host-smoke.mjs` tool unless noted.

1. **HTTP route serves `index.html` at `/s/<slug>/`** — register a
   bundle via the real `executeRegisterTool`, then a live `http.Server`
   running `serveStaticHostRoute` is curled. Asserts 200, body content,
   `text/html` content-type, `no-cache` cache-control.
2. **Nested asset MIME** — `GET /s/<slug>/sub/app.js` → 200,
   `application/javascript`.
3. **Subdirectory → `index.html`** — `GET /s/<slug>/sub/` → 200 with
   the subdir's index.
4. **Unknown slug 404 (does not fall through)** — `GET /s/no-such/`
   returns 404 and `handled=true`.
5. **Path-traversal rejected** — `GET /s/<slug>/..%2Fsecret.txt`
   returns 404 (resolved path outside bundle root).
6. **Prefix mismatch falls through** — `GET /unrelated` → handler
   returns `handled=false`.
7. **Persistence file shape after register** — JSON under
   `${storeDir}/<sessionId>.json` has `{ version: 1, entries: [...] }`
   with the expected slug, folderPath, and cardMetadata.
8. **Session evict drops registrations** —
   `registry.unregisterAllForSession(sid)` empties the slug; HTTP route
   now 404s for that slug.
9. **Session rehydrate replays from disk** — re-invoke the extension
   factory against a fresh session (same sessionId), and the previously
   written JSON file replays through `session_start` →
   `registry.register` is called and a `panel_update`-shaped event is
   emitted on the `pimote:panels` channel with `href: /s/<slug>/`.
10. **Boot-time GC removes orphan store files** — populate the store
    dir with files for a live sessionId and an orphan sessionId, run
    `gcStaticHostStore`, assert the orphan is gone and the live file is
    intact.
11. **Remove tool tears down route + card** — `executeRemoveTool` →
    `removed: true`, HTTP route returns 404, store file no longer lists
    the slug, panel snapshot re-emitted (without the card).
12. **Anchor renders as `<a href>` in `Panel.svelte`** — agent-browser
    against a live pimote with a pre-seeded static-host store file.
    Confirms an `<a>` element with `href="/s/<slug>/"` is present in
    the side panel for a card with `href`. Click navigates to the
    bundle and `index.html` content appears in the browser.
13. **Service worker passes `/s/*` through** — with the SW registered
    and active, fetch `/s/<slug>/` from the page context; response
    comes from the server (response headers include `cache-control:
no-cache` from the static-host handler, not the SW shell). Devtools
    network panel shows the request reaches the network.
14. **Browser back returns to the session** — after clicking the
    panel-card link, `history.back()` returns to the session view with
    the same `viewedSessionId` (coherence pass for the "navigate away,
    browser-back to return" intent in the brainstorm).

## Tools

- **Reused:** none (no prior tools applicable to static-host).
- **New:** `tools/manual-test/static-host-smoke/` — Node script that
  spins up an `http.Server` running the shipped `serveStaticHostRoute`,
  exercises `executeRegisterTool` / `executeRemoveTool`, verifies
  persistence, simulates session evict + rehydrate, and runs
  `gcStaticHostStore`. Drives tests 1–11.
- **New:** `tools/manual-test/static-host-pwa-smoke/` — Node script that
  boots a real `pimote` server in a sandboxed `XDG_*` workspace, drives
  the PWA via `agent-browser` to open a session, pre-seeds the
  static-host store file for that session, restarts the server,
  observes the panel card, and clicks through to verify the
  `/s/<slug>/` bundle serves. Drives tests 12–14.

## Harness Limitations

- The server-side smoke (`static-host-smoke`) bypasses the pi
  `ExtensionAPI` and invokes `executeRegisterTool` / `executeRemoveTool`
  directly with a fake `emitPanelCards` capture. That matches what the
  shipping extension does, but doesn't exercise the pi SDK's tool
  invocation pathway. The `index.test.ts` unit suite covers that seam
  with a fake `ExtensionAPI`, so the gap is only in the integration
  layer — minor.
- The PWA smoke (`static-host-pwa-smoke`) pre-seeds the on-disk
  persistence file rather than invoking `pimote_static_host` from a
  real LLM-driven agent turn. The tool body is exercised by the
  server-side smoke; the PWA smoke verifies what the user sees once
  the card has been emitted. This means we never exercise the
  agent → tool → emit flow in one end-to-end shot; we exercise its
  two halves separately and rely on `index.test.ts` to stitch them.
- The PWA smoke runs headless Chromium via `agent-browser`. Visual
  layout / theming aren't checked; the test asserts DOM structure
  (anchor presence, href, navigation result), not appearance.

## Results

### Smoke Suite

- Journey 6 (Panel cards from extensions) is exercised as part of tests
  12–14 below; not run separately.

### Topic-Specific Tests

| #   | Test                                           | Driver                | Verdict  | Notes                                                                                                                                                     |
| --- | ---------------------------------------------- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HTTP route serves `index.html` at `/s/<slug>/` | static-host-smoke     | **pass** | 200 + `text/html` + `no-cache`.                                                                                                                           |
| 2   | Nested asset MIME                              | static-host-smoke     | **pass** | `.js` resolved to JS MIME.                                                                                                                                |
| 3   | Subdirectory → `index.html`                    | static-host-smoke     | **pass** | `/s/<slug>/sub/` served subdir index.                                                                                                                     |
| 4   | Unknown slug 404, no SPA fall-through          | static-host-smoke     | **pass** | 404 + handler returns `handled=true`.                                                                                                                     |
| 5   | Path-traversal rejected                        | static-host-smoke     | **pass** | `..%2F` decoded server-side and rejected.                                                                                                                 |
| 6   | Prefix mismatch falls through                  | static-host-smoke     | **pass** | `/unrelated` hits the stub SPA fallback.                                                                                                                  |
| 7   | Persistence file shape after register          | static-host-smoke     | **pass** | `{version:1, entries:[…]}` with slug + folder + cardMetadata.                                                                                             |
| 8   | Session evict drops registrations              | static-host-smoke     | **pass** | Route 404s after `unregisterAllForSession`.                                                                                                               |
| 9   | Session rehydrate replays from disk            | static-host-smoke     | **pass** | Replayed registry has slug; reconstructed card carries `href: /s/<slug>/`.                                                                                |
| 10  | Boot-time GC removes orphan store files        | static-host-smoke     | **pass** | Orphan json deleted, live json + non-json files preserved, missing dir tolerated.                                                                         |
| 11  | Remove tool tears down route + card            | static-host-smoke     | **pass** | 404 after remove; store file updated; empty snapshot re-emitted; cross-session remove no-ops.                                                             |
| 12  | Anchor renders as `<a href>` in `Panel.svelte` | static-host-pwa-smoke | **pass** | `link "Smoke Bundle Card smoke"` in accessibility snapshot; `href="/s/static-host-pwa-smoke-bundle/"`.                                                    |
| 13  | Service worker passes `/s/*` through           | static-host-pwa-smoke | **pass** | Page-context `fetch` returns 200 + `cache-control: no-cache, no-store, must-revalidate` from the server (would be absent if SW had served the SPA shell). |
| 14  | Browser-back returns to the session view       | static-host-pwa-smoke | **pass** | URL drops back to `/`; session input bar + folder list + panel link visible in re-snapshot.                                                               |

**Coherence pass (UI-bearing tests 12–14):** _looks coherent._ The
panel card renders as a plain bordered block whose entire surface is a
same-tab link to the bundle, the bundle renders as plain HTML at the
expected path with no SPA chrome injected, and browser-back lands
cleanly on the session with the panel still showing the card.

## Plan Updates

No persistent-plan changes. Static-host is a tool surface inside
existing journey 6 (Panel cards from extensions); adding it as its own
primary journey would dilute the plan. Topic-specific tests above
cover the new behaviours.

## Open Issues

None.
