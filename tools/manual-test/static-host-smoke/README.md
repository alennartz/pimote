# static-host-smoke

End-to-end smoke for the server-side static-host pipeline:

- `executeRegisterTool` / `executeRemoveTool` against real
  `InMemoryStaticHostRegistry` + `FileStaticHostStore`.
- Live `http.Server` running `serveStaticHostRoute` — exercised via
  real `fetch` requests (URL `/s/<slug>/`).
- Session evict / rehydrate simulated by calling
  `registry.unregisterAllForSession` and then replaying the on-disk
  store file through the same code path the extension's
  `session_start` handler uses.
- `gcStaticHostStore` against a populated store directory.

Drives manual-test tests 1–11 in `docs/manual-tests/static-resources.md`.

## Location

`tools/manual-test/static-host-smoke/static-host-smoke.mjs`

## Invocation

```bash
npm run build
node tools/manual-test/static-host-smoke/static-host-smoke.mjs
```

## Inputs

None. The script uses `fs.mkdtemp` to build its own bundle + store
directories under `os.tmpdir()` and tears them down on exit.

## Outputs

- Per-test ✓/✗ lines on stdout.
- Non-zero exit status if any assertion fails.

## Prerequisites

- Workspaces built (`server/dist`, `shared/dist`).
- No real network, no real LLM, no pimote server boot required.
