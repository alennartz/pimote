# Manual Testing — per-assistant-turn-cost

## Smoke Suite

- **Journey 1 — Connect and open a session.** Open the fabricated priced session, inspect the session total in the desktop status bar and mobile session settings, and verify metadata after reload. This is the feature's whole-session disclosure path. Driver: `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs` with `agent-browser`.
- **Journey 2 — Prompt → streamed assistant response.** Inspect separate assistant transcript rows, matching nested tool-result usage, partial/final replacement, and interrupted-row cost. This is the feature's per-assistant disclosure path. Driver: `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs` with `agent-browser`; the approved interaction mock supplements responsive and keyboard checks.

## Topic-Specific Tests

- Desktop transcript placement: a positive row cost is left of the bot icon, one button appears per assistant row, and the session cost remains in the desktop status bar.
- Narrow PWA placement: row cost moves to the right of the bot icon; an interrupted-row cost remains beside the interrupted label; the session total is available from mobile session settings.
- Cost disclosure interaction: click/tap, Enter, and Space open a popover; Escape, the close control, and outside click close it; only one cost popover stays open.
- Category disclosure: input, output, cache read, and cache write token/cost rows render with four-decimal costs; positive Unknown appears only for a remainder above one cent; no synthetic Tools category or negative Unknown appears.
- Usage lifecycle: partial snapshots replace earlier snapshots; final usage wins; matching tool-result usage contributes to the correct assistant row; interrupted partial-only usage remains active-view-only.
- Session accounting: Pi's scalar total includes persisted compaction, branch-summary, usage, assistant, and tool-result entries; actual cache-read and cache-write usage remains visible; the forecast is absent.
- Resync and reload: persisted final usage survives full resync and reload; transient terminal fallback drops after full resync and reload.
- Zero/invalid disclosure: zero-spend sessions render no cost trigger.

## Tools

- Reused: `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs`, `tools/manual-test/lib/browser.mjs`, and the `agent-browser` skill.
- Reused: `docs/mocks/per-assistant-turn-cost/index.html` as the approved desktop and narrow-layout interaction contract.
- New: none.
- Improved: none.

## Harness Limitations

The smoke uses real server and PWA code plus a real browser, but it fabricates Pi session JSONL and injects live protocol events instead of running a live model. It cannot expose provider-specific streaming timing, model-run races, or live network failures. The approved mock is static HTML, so it validates interaction intent and responsive placement rather than production CSS integration. These gaps weaken timing and live-stream coverage, but persisted accounting, row correlation, resync/reload behavior, and the primary cost disclosures remain exercised by real production code.

## Results

_To be filled after execution._

## Plan Updates

None. The cost feature extends the existing connect/open and streamed-response journeys; it does not add a new primary journey.

## Open Issues

_To be filled after execution._
