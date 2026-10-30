# Manual Testing — global-settings

## Smoke Suite

This run exercised the global Settings journey and its adjacent home flows.
The focus hints scoped the subset to:

- Journey 1: connect to the dashboard and open the home surface.
- Journey 12: retain folder-row `AGENTS.md` editing while global Settings moves to the home gear.
- Journey 13: responsive home-only Settings, tabbed drafts, missing-file creation,
  Markdown controls, native configuration validation and reload, and Pimote
  extension discovery.

## Topic-Specific Tests

- Desktop and mobile home gear placement and conversation omission.
- Server-resolved manifest ordering, labels, lazy tab reads, per-tab drafts,
  missing-file creation, and Markdown-only controls.
- Native Pimote configuration invalid-write rejection, valid capability refresh,
  symlink identity, dynamic settings-file updates, and two-client capability
  fan-out.
- Server-wide `/reload` ordering and extension discovery, including valid
  modules, replacement registrations, and isolated factory failures.
- Folder-row `AGENTS.md` editing remains available after the global entry point
  moves.

## Tools

- Reused: `tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs`.
- Reused: `agent-browser` for browser/PWA interaction.
- Reused: `bash`, `tools/manual-test/lib/ws-probe.mjs`, and focused server/client
  tests for native config and extension-host seams.
- Improved: `agents-md-editor-smoke` now verifies that Save cleans the active
  tab while the dialog remains open, matching the approved per-file-save mock;
  it closes the clean dialog with Cancel before reopening.
- New: none.

## Harness Limitations

The Settings smoke uses a real sandboxed server and Chromium, but it has one
seeded browser client and fabricated files, not two live browser windows.
Native configuration and extension reload checks use direct WebSocket/file
probes. They do not exercise a live Pi model, external network, or a real
installed Pi package manager. These limits weaken concurrency beyond the
capability fan-out probe, real package installation resolution, and resource
leaks from third-party extensions. The primary home Settings path has a real
browser driver. Extension package scope and lifecycle isolation also have
focused server contract tests. No primary behavior was silently accepted
without a driver.

## Results

| Item                                            | Invocation and observation                                                                                                                                                                                                                                 | Verdict                                                                                                                                                                                          | Coherence                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Journey 1 — dashboard entry                     | `npm run build`; `agents-md-editor-smoke` booted a real sandbox server, opened the dashboard, used `agent-browser snapshot -i`, and clicked the Settings gear ref.                                                                                         | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 12 — folder instructions                | In the live session surface, the browser showed `Edit folder AGENTS.md`; clicking it opened the existing path-based editor with Tag/snippet controls. Cancel returned to the conversation, and no global gear appeared.                                    | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 13 — desktop gear and actions           | At 1280×900, the gear measured 56×56 at x=24, y=820, with the desktop class. The dialog exposed footer Cancel/Save.                                                                                                                                        | **pass**                                                                                                                                                                                         | looks coherent; `/tmp/global-settings.png` shows the approved fullscreen editor without a redundant Settings title. |
| Journey 13 — mobile gear and actions            | At 390×844, the gear measured 40×40 at x=12, y=12, with the mobile class. The dialog exposed header Close/Save. `/tmp/global-settings-mobile.png` showed the header, tabs, Markdown toolbar, and editor without overlap.                                   | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 13 — conversation omission              | The session URL had no `Open Settings` gear while retaining the folder-row `Edit folder AGENTS.md` action.                                                                                                                                                 | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 13 — tabs and independent drafts        | Selected missing `settings.json`, entered `draft-settings`, switched to `AGENTS.md`, then returned. The settings draft and `*` dirty marker remained. The JSON tab had no Tag controls.                                                                    | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 13 — missing-file creation              | Saved the missing `settings.json` tab on mobile. The file appeared on disk, the New file hint disappeared, and Save became disabled.                                                                                                                       | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Journey 13 — Markdown controls and save/discard | `agents-md-editor-smoke` verified server snippets, freeform selection wrapping, snippet block insertion, per-file save, Keep editing, Escape veto, and Discard.                                                                                            | **fixed-inline** — the driver initially expected Save to close the dialog. The approved mock keeps the dialog open after each per-file save, so the driver was corrected and rerun successfully. | looks coherent                                                                                                      |
| Native config — invalid and symlink writes      | Two `WsProbe` clients sent an invalid empty-roots candidate. Both native and symlink-alias writes returned validation errors; a subsequent `file_get` matched the original bytes.                                                                          | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Native config — valid reload and capabilities   | A valid `tagSnippets` update returned success and sent `server_capabilities` with `review`/`ship` to both probes. A `settingsFiles: ["extra.md"]` update did not change the open dialog tabs, then appeared after close/reopen.                            | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| `/reload` Pimote discovery                      | The browser sent `/reload` through the live session. A newly added direct module contributed `replacement.md`; a broken module logged an isolated diagnostic; after the second reload the valid replacement remained and the old registration disappeared. | **pass**                                                                                                                                                                                         | looks coherent                                                                                                      |
| Contract backstop                               | `npm run test --workspace=@pimote/server -- --run src/config-runtime.test.ts src/global-settings.test.ts src/pimote-extensions/host.test.ts src/ws-handler.test.ts` passed 187 tests. Client global-settings tests passed 33 tests.                        | **pass**                                                                                                                                                                                         | not UI-bearing                                                                                                      |

## Plan Updates

Empty. Journey 13 and its driver already existed in `tools/manual-test/PLAN.md`.

## Open Issues

Empty. The only failure was an outdated manual-driver assertion and was fixed
inline before the successful rerun.
