# Manual Testing — cost-accumulation

## Smoke Suite

This topic surfaces a per-session lifetime dollar cost in the StatusBar. The
StatusBar only appears once a session is open, so the relevant primary
journeys are:

- **Journey 1 — Connect and open a session.** The cost figure is delivered by
  the `get_session_meta` round-trip fired on session open; if open or the meta
  fetch regresses, the figure never appears (and the StatusBar may break).
- **Journey 2 — Prompt → streamed assistant response.** `get_session_meta` also
  refreshes on `agent_end`, the moment new spend would accrue. Smoked only to
  the extent the cost-bearing StatusBar must keep rendering — not a full
  prompt/stream re-exercise (no live LLM in this harness).

Journeys 3–9 are out of scope (focus hint: don't re-exercise unrelated
surfaces).

## Topic-Specific Tests

1. **Nonzero cost renders as `$X.XX` in the StatusBar.** Open a session whose
   on-disk branch carries assistant entries with `usage.cost.total`; the server
   recomputes `lifetimeCostUsd` via `sumAssistantCostUsd(getBranch())` and the
   StatusBar shows the `formatSessionCost`-formatted figure (desktop Row 1).
   Why: the headline behavior of the topic.
2. **`get_session_meta` does not throw on a real session.** The handler at
   `ws-handler.ts:924` now calls `sumAssistantCostUsd` over the rehydrated
   branch; verify the response succeeds with a numeric `lifetimeCostUsd`.
   Why: a throw here would break every session's metadata, not just cost.
3. **Zero / no-spend session hides the indicator.** A fresh session (no
   assistant entries, or unpriced model → `cost.total === 0`) yields
   `lifetimeCostUsd: 0`; `formatSessionCost(0)` returns `null` and the StatusBar
   shows no cost span. Why: the documented hidden-when-zero behavior, and the
   state reachable in-environment without real LLM spend.
4. **Filtering correctness end-to-end.** The fabricated branch interleaves
   user / toolResult / `model_change` entries among the priced assistant
   entries; the surfaced figure equals the sum over _assistant_ entries only.
   Why: confirms the real recompute path (not just the unit test) filters as
   specified.

## Tools

- Reused: `agent-browser` skill (mandatory driver for PWA journeys); the
  sandbox-boot + session-fabrication pattern from `static-host-pwa-smoke`.
- New: `tools/manual-test/cost-accumulation-smoke/` — boots a sandboxed pimote,
  fabricates a pi session JSONL with priced assistant entries (plus
  non-contributing entries), drives the PWA via `agent-browser`, and asserts the
  StatusBar cost figure (nonzero session) and its absence (zero session).
- Improved: none.

## Harness Limitations

- **No live LLM.** Real token spend against a priced model is not reachable
  in-environment. The nonzero figure is produced by fabricating a pi session
  JSONL whose assistant entries carry real-format `usage.cost.total` values,
  which pi's `SessionManager` rehydrates into the in-memory branch on session
  open — the exact path the plan relies on for "survives a server restart for
  free." This faithfully exercises the server recompute (`sumAssistantCostUsd`
  over `getBranch()`) and the full client render path. What it does **not**
  exercise: pi's own per-message pricing-table computation (we supply the
  numbers pi would otherwise compute) and the `agent_end`-triggered refresh
  with freshly-incurred spend. Those are structurally invisible to this harness;
  the unit tests cover the summation contract and the formatting contract.
- **Headless Chromium, single client.** Standard for the PWA harness; no
  concurrency or real-device layout concerns, which this topic doesn't touch.

## Results

**Unit suites (regression guard, not the smoke itself):**

- `server: vitest run src/session-cost.test.ts` → 12/12 pass. **pass**
- `client: vitest run src/lib/session-summary.test.ts src/lib/stores/session-registry.test.ts` → 80/80 pass. **pass**

**Smoke + topic-specific (driver: `tools/manual-test/cost-accumulation-smoke/`):**

- **Journey 1 (connect + open) / get_session_meta health.** Booted a
  sandboxed `bin/pimote.js`; opened both fabricated sessions over the WS.
  `get_session_meta` succeeded for both (no throw), returning a numeric
  `lifetimeCostUsd`. **pass.** Coherence: PWA loads, folder list + sessions
  render, session opens to the chat view — **looks coherent.**
- **Topic 1 — nonzero cost renders `$X.XX`.** Priced session (assistant
  costs `0.50 + 0.73`) → StatusBar `[title="Session cost"]` shows `$1.23` in
  both the desktop Row 1 and mobile Row 2 spans (`"$1.23|$1.23"`). **pass.**
  Coherence (screenshot): `$1.23` sits muted next to the connection status,
  same visual weight as siblings — **looks coherent.**
- **Topic 2 — `get_session_meta` does not throw.** Both priced and zero
  sessions returned a successful response with numeric `lifetimeCostUsd`
  (`1.23` / `0`). **pass.**
- **Topic 3 — zero / no-spend hides the indicator.** Zero-spend session
  reported `lifetimeCostUsd: 0`; the PWA rendered zero `[title="Session cost"]`
  spans. **pass.** Coherence (screenshot): StatusBar shows the connection
  status with no cost figure and no layout gap — **looks coherent.**
- **Topic 4 — filtering correctness end-to-end.** The fabricated priced
  branch interleaved `model_change`, user-`prompt`, and `toolResult`-style
  user entries among the two priced assistant turns; the surfaced figure
  equalled the assistant-only sum (`1.23`, within 1e-9). **pass.**

**Nonzero-figure note (per focus hint):** a nonzero cost normally requires
real LLM token spend against a priced model, which is not reachable
in-environment (the sandbox boots with `0 models available`). Rather than
leave the figure at `$0`, the harness fabricates pi session JSONLs whose
assistant entries carry real-format `usage.cost.total` values; pi rehydrates
them into the branch on open (the plan's documented restart-survival path),
so the server recompute and the client render are both exercised against a
genuine `$1.23`. The zero/hidden state is also verified directly. No figure
was "forced" client-side — it flows through `sumAssistantCostUsd` →
`SessionMeta.lifetimeCostUsd` → `formatSessionCost`.

## Plan Updates

None. The per-session cost figure is a sub-element of the StatusBar exercised
within existing journeys 1 (connect + open) and 2 (prompt → response), not a
standalone primary journey — `tools/manual-test/PLAN.md` stays focused and is
unchanged. The new driver is registered in `tools/manual-test/README.md`.

## Open Issues

None. All smoke and topic-specific tests pass; no inline fixes were required
(the implementation matched the plan and review). The only harness wrinkles
resolved during setup were in the test driver itself (open-by-id needs
`folderPath` + reopen assigns a fresh sessionId; command responses carry no
`type` field; the cost `<span>` is non-interactive so it must be read via DOM
eval, not the `-i` accessibility snapshot) — none of these are product issues.
