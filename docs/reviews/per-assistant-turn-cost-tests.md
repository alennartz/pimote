# Test Review: Per-assistant-message cost

**Plan:** `docs/plans/per-assistant-turn-cost.md`
**Brainstorm:** `docs/brainstorms/per-assistant-turn-cost.md`
**Date:** 2026-10-23

## Summary

The approved automated contract now covers usage projection, wire delivery, client state, authoritative metadata, and numeric disclosure behavior. Tests exercise public boundaries with fixed data. Interaction and responsive-layout validation remain in the manual-testing phase.

## Findings

### 1. Wire and lifecycle coverage was absent

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/per-assistant-turn-cost.md:181-221`
- **Status:** resolved

The original tests covered only two reducers. They did not cover usage mapping, partial snapshot replacement, final replay/resync/reload, terminal fallback, or authoritative metadata. The parent approved adding these tests. Added `server/src/message-usage.test.ts`, `client/src/lib/stores/session-usage.test.ts`, and metadata command coverage. The plan now defines public row access without prescribing fallback storage. Terminal wire messages remain unchanged.

### 2. Numeric disclosure rules lacked a boundary

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/per-assistant-turn-cost.md:130-151`
- **Status:** resolved

The brainstorm requires number-only formatting, hidden invalid totals, one-cent tolerance, positive Unknown, and no negative Unknown. Added the cost-disclosure interface and tests. The parent approved automated mismatch coverage. The projection retains the reported scalar total and marks larger category overages inconsistent.

### 3. Forecast tests required removed behavior

- **Category:** unplanned scope
- **Severity:** warning
- **Location:** `server/src/ws-handler.test.ts:2781-2830`
- **Status:** resolved

Existing forecast tests contradicted the settled removal contract. The parent approved their migration. They now require forecast absence with known and unknown pricing. New client-state coverage also requires forecast absence. Production removal remains implementation work, including the temporary optional protocol field.

### 4. Interaction validation had no automated coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/plans/per-assistant-turn-cost.md:139-151`
- **Status:** dismissed

The parent assigned click/tap, keyboard behavior, responsive placement, and popover integration to default manual testing. The approved mock supplies the visual contract. The plan records this validation boundary.

### 5. Aggregate assertions required exact decimal arithmetic

- **Category:** over-specified
- **Severity:** warning
- **Location:** `client/src/lib/assistant-row-usage.test.ts:81-105`
- **Status:** resolved

Decimal additions can differ by floating-point rounding. Replaced exact aggregate dollar assertions with close comparisons. Token assertions remain exact.

### 6. Subset fixture omitted subset fields

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/assistant-row-usage.test.ts:122-138`
- **Status:** resolved

The streaming test claimed to prevent subset double-counting but supplied no subsets. Added nonzero `cacheWrite1h` and `reasoning` values. Expected token totals remain unchanged.

## Validation

No timing, randomness, network state, or filesystem-order dependencies were introduced. Interfaces remain unimplemented where new behavior is required. Tests were not run in this review phase.
