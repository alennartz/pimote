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

The smoke uses real server and PWA code plus a real browser, but it fabricates Pi session JSONL and injects live protocol events instead of running a live model. It cannot expose provider-specific streaming timing, model-run races, or live network failures. The approved mock is static HTML, so it validates interaction intent and responsive placement rather than production CSS integration. For this run, a disposable viewport extension also exercised the production PWA at 390×844. These gaps weaken timing and live-stream coverage, but persisted accounting, row correlation, resync/reload behavior, and the primary cost disclosures remain exercised by real production code.

## Results

### Smoke Suite

- **Journey 1 — Connect and open a session — pass.** Ran `npm run build`, then `node tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs`. The real sandboxed server returned Pi's `$1.66` complete-session total, all four category costs, the positive `$0.07` Unknown remainder, actual cache-read/cache-write costs, and zero cost for the control session. The desktop status-bar disclosure and reload path matched the metadata. Coherence: **looks coherent**.
- **Journey 2 — Prompt → streamed assistant response — pass.** The same smoke rendered separate `$0.92` and `$0.60` assistant rows, counted each matching nested tool result once, replaced `$0.11` partial usage with `$0.25`, retained the partial-only terminal cost, and restored persisted rows after resync/reload. Coherence: **looks coherent**.

### Topic-Specific Tests

- **Desktop transcript placement — pass.** The desktop production transcript placed each positive cost left of its bot icon, while the session total stayed in the status bar. The approved desktop mock showed the same hierarchy. Coherence: **looks coherent**.
- **Narrow PWA placement — pass.** At a 390×844 production viewport, row cost appeared to the right of the bot icon, the interrupted fallback stayed beside `interrupted`, and mobile session settings exposed the session total and cost popover. The approved narrow mock showed the same arrangement. Coherence: **looks coherent**.
- **Cost disclosure interaction — pass.** `agent-browser` opened disclosures by desktop click, narrow click/tap, Enter, and Space. Escape, the close control, and an outside pointer click closed them. Opening a second trigger closed the first. Coherence: **looks coherent**.
- **Category disclosure — pass.** The session and row popovers showed Input, Output, Cache read, and Cache write with token counts and four-decimal costs. The session popover showed positive Unknown only for the `$0.07` remainder and no Tools category or negative Unknown. Coherence: **looks coherent**.
- **Usage lifecycle — pass.** Partial snapshots replaced earlier snapshots. Final persisted usage took precedence. Matching nested tool-result usage contributed to the owning assistant row, and the active-view terminal fallback rendered beside the interrupted row. Coherence: **looks coherent**.
- **Session accounting and forecast removal — pass.** Metadata included assistant, tool-result, compaction, branch-summary, and usage entries in Pi's scalar total. Actual cache-read/cache-write costs remained visible. Production source and metadata checks contained no `nextRoundtripCostUsd`, `formatCombinedCost`, or `sumLifetimeCostUsd` references. Coherence: **looks coherent**.
- **Resync and reload — pass.** Full resync restored in-flight usage and persisted final rows, then removed the transient fallback when settled. Reload restored the Pi total and final row costs without restoring the client-only partial. Coherence: **looks coherent**.
- **Zero/invalid disclosure — pass.** The zero-spend control session rendered no cost trigger. Coherence: **looks coherent**.

## Plan Updates

None. The cost feature extends the existing connect/open and streamed-response journeys; it does not add a new primary journey.

## Open Issues

None.
