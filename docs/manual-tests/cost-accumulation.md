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

(filled in during execution)

## Plan Updates

(filled in during execution)

## Open Issues

(filled in during execution)
