# Test Review: Web themes

**Plan:** `docs/plans/client-themes.md`  
**Brainstorm:** `docs/brainstorms/client-themes.md`  
**Date:** 2026-11-19

## Summary

The review added coverage for catalog validation, theme propagation, rendering, reports, and Appearance interactions. Tests exercise public boundaries with complete theme fixtures. Theme interfaces remain unimplemented, so the new behavioral tests fail until implementation.

## Findings

### 1. Missing WebSocket and user propagation coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/ws-themes.test.ts:125-189`
- **Status:** resolved

The original tests bypassed the WebSocket transport and did not verify shared selections or catalog isolation. The user approved tests for catalog requests, revision events, same-user propagation, other-user isolation, and the initial connect payload.

### 2. Missing renderer coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `client/src/lib/theme-rendering.test.ts:91-247`
- **Status:** resolved

No tests protected paired code colors across CodeMirror, Highlight.js, or ANSI output. The user approved rendered-color tests, a CodeMirror theme interface, themed standard ANSI slots, and unchanged indexed colors.

### 3. Missing catalog and fallback cases

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/theme-catalog.test.ts:19-235`; `server/src/theme-preferences.test.ts:46-83`
- **Status:** resolved

The original catalog tests omitted shipped presets, schema and color errors, low-contrast acceptance, watched file changes, changed defaults, and missing-parent fallback. The user approved coverage and a controllable watcher seam.

### 4. Invalid theme fixtures

- **Category:** over-specified
- **Severity:** critical
- **Location:** `shared/test/theme-fixtures.ts:1-178`; `server/src/theme-catalog.test.ts:8-33`
- **Status:** resolved

Standalone fixtures omitted required tokens, although the architecture rejects incomplete themes. Complete fixtures now supply every UI, surface, syntax, and terminal role. Catalog assertions no longer mistake partial arrays for complete snapshots.

### 5. Report and authoring integration gaps

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/theme-report-entry.test.ts:36-83`; `server/src/pimote-docs/index.test.ts:30-39`; `server/src/static-host/http-handler.test.ts:84-100`
- **Status:** resolved

The original tests did not establish current-user discovery, report updates, guide registration, or verbatim report serving. The user approved an entry seam that reads `pimote:user` and tests for those contracts. The bridge asset must still be included at the planned public URL during implementation.

### 6. Appearance tests did not exercise the mock flow

- **Category:** wrong abstraction
- **Severity:** warning
- **Location:** `client/src/lib/components/AppearanceSettings.test.ts:51-108`
- **Status:** resolved

Button counts and direct store state did not establish visible preview, Save, or Cancel behavior. The user approved interaction tests against visible status and protocol commands. Mobile Close now cancels an unsaved preview.

### 7. Tests did not observe palette effects

- **Category:** wrong abstraction
- **Severity:** warning
- **Location:** `client/src/lib/theme-application.test.ts:7-41`; `client/src/lib/theme-bootstrap.test.ts:8-31`; `client/src/lib/theme-bridge.test.ts:25-66`
- **Status:** resolved

Several assertions checked return values or listeners without checking rendered properties. The tests now use DOM styles to verify palette application, fallback preservation, cross-tab changes, and teardown.

### 8. Over-specified revisions and false fallback setup

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/theme-catalog.test.ts:217-235`; `server/src/theme-preferences.test.ts:79-83`
- **Status:** resolved

A catalog test required revisions to start at one and increment after an unchanged reload. A fallback test never made the default unavailable. The tests now require a monotonic revision on a real change and configure a missing default.

### 9. Swatch inheritance and home-relative paths

- **Category:** unplanned scope
- **Severity:** warning
- **Location:** `server/src/theme-catalog.test.ts:82-115`; `server/src/pimote-extensions/themes.test.ts:23-35`
- **Status:** dismissed

The user approved inherited swatches with child overrides and `~` expansion matching settings files. The plan records both contracts, and the tests retain them.
