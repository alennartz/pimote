# static-host-pwa-smoke

Drives the **client-side** verifications deferred to manual testing in
`docs/reviews/static-resources-tests.md`:

- `Panel.svelte` renders a card with `href` as a clickable `<a>`.
- `/s/<slug>/` requests pass through the service worker to the network
  unmodified.
- Browser-back from a hosted bundle returns to the session view.

The script:

1. Builds a sandboxed `HOME` (so pi state, pimote state, and pimote
   config are isolated).
2. Spawns `pimote` on a free port.
3. Opens a WebSocket as a fake client, creates a fresh session in the
   sandbox project folder via `open_session`, captures its sessionId,
   closes the WS, and stops pimote.
4. Writes `<storeDir>/<sessionId>.json` with one static-host entry
   pointing at a bundle inside the project folder.
5. Restarts pimote (boot-time GC keeps the file because the sessionId
   is in `FolderIndex`).
6. Uses `agent-browser` to open the PWA, navigate into the project +
   session — the extension's `session_start` handler replays the entry
   and emits a panel card with `href: /s/<slug>/`.
7. Asserts:
   - An `<a href="/s/static-host-pwa-smoke-bundle/">` element renders
     in the panel.
   - Clicking it lands on `/s/static-host-pwa-smoke-bundle/` and the
     bundle's `index.html` body is visible (proves SW pass-through —
     no SPA shell).
   - `history.back()` returns to the session view.

Drives manual-test tests 12–14 in `docs/manual-tests/static-resources.md`.

## Location

`tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs`

## Invocation

```bash
npm run build
node tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs
```

## Inputs

None. The script builds its own sandbox under `os.tmpdir()` and tears
it down on exit.

## Outputs

- Per-test ✓/✗ lines on stdout.
- Pimote and `agent-browser` stdout/stderr captured to log files inside
  the sandbox, paths printed on failure.
- Non-zero exit status if any assertion fails.

## Prerequisites

- Workspaces built (`npm run build`).
- `agent-browser` on `PATH`.
- A working `HOME` writable temp dir.
