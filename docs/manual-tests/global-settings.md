# Manual Testing — global-settings

## Smoke Suite

This run exercises the global Settings journey and its adjacent home flows.
The focused subset includes:

- Journey 1: connect to the dashboard and open the home surface.
- Journey 12: retain folder-row `AGENTS.md` editing while global Settings moves to the home gear.
- Journey 13: responsive home-only Settings, tabbed drafts, missing-file creation,
  Markdown controls, native configuration validation and reload, and Pimote
  extension discovery.

The focus hints scope this run to Settings and the dashboard/editor surfaces.

## Topic-Specific Tests

- Desktop and mobile home gear placement and conversation omission.
- Server-resolved manifest ordering, labels, lazy tab reads, per-tab drafts,
  missing-file creation, and Markdown-only controls.
- Native Pimote configuration invalid-write rejection, valid capability refresh,
  and dynamic policy observations.
- Server-wide `/reload` ordering, extension discovery scope, diagnostics, and
  extension settings replacement.
- Folder-row `AGENTS.md` editing remains available after the global entry point
  moves.

## Tools

- Reused: `tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs`.
- Reused: `agent-browser` for browser/PWA interaction.
- Reused: `bash`, WebSocket probes, and focused server tests for native config
  and extension-host seams.
- New: none planned unless an existing driver cannot exercise a required
  contract.

## Harness Limitations

The existing Settings smoke uses a real sandboxed server and Chromium, but it
has one seeded browser client and fabricated files, not a second live browser.
Native configuration and extension reload checks use direct WebSocket/file
probes and test fixtures rather than a live Pi process and installed package
manager. These limits weaken concurrency, real external-package resolution,
real extension resource leaks, and cross-client capability fan-out checks. The
core topic has direct server contracts and browser checks, so no primary
behavior is silently accepted without a driver. Any weakened primary behavior
will be called out in Results or Open Issues.

## Results

Pending execution.

## Plan Updates

Empty unless execution reveals a new primary journey or a driver change.

## Open Issues

Pending execution.
