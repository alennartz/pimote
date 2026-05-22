# Test Review: Static Resources

**Plan:** `docs/plans/static-resources.md`
**Brainstorm:** `docs/brainstorms/static-resources.md`
**Date:** 2026-05-21

## Summary

Tests for the server-side static-host module cover the brainstorm intent at the right abstraction level — registry, persistence store, boot-time GC, HTTP route handler, tool bodies, and extension factory each exercised through their interface surface with happy paths, boundary conditions, and error cases. One critical bug in the HTTP traversal test was fixed inline (URL normalisation in the test client was neutralising the `..` segment before it reached the handler). Two client-side behaviours from the brainstorm (Panel.svelte `<a>` rendering, service-worker `/s/*` bypass) are intentionally not covered at this layer; they are deferred to the manual-testing pipeline phase.

## Findings

### 1. HTTP traversal test was normalised away by `fetch`

- **Category:** wrong abstraction
- **Severity:** critical
- **Location:** `server/src/static-host/http-handler.test.ts:138-148`
- **Status:** resolved

The original test issued `fetch('/s/demo/../secret.txt')`. The WHATWG URL parser used by `fetch` (and Node's `URL`) normalises `..` segments client-side, so the request that reached the server was `/s/secret.txt` — the handler's traversal-rejection code path was never executed. The test happened to pass because `secret.txt` was an unknown slug returning 404, giving false confidence in the traversal defence.

Fixed inline by switching to percent-encoded separators that survive URL normalisation: `'/s/demo/..%2Fsecret.txt'` (POSIX) and `'/s/demo/..%5Csecret.txt'` (Windows-style backslash, also worth defending against on cross-platform input). Both variants now assert `handled === true` and `status === 404` so the handler is forced to decode the path and reject the resolved escape.

### 2. No test for `Panel.svelte` rendering `<a href>` for clickable cards

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/components/Panel.svelte` (no test file)
- **Status:** dismissed

Brainstorm key decision: "Card-level clickability only, same-tab navigation. `href` on `Card` makes the whole card a same-tab link." The plan's Tests section lists no client-side component test, and the repo has no Svelte component testing framework for `client/src/lib/components/`. Standing up that infrastructure is out of scope for this topic.

Dismissed with the explicit understanding that the `href` rendering will be verified during the manual-testing phase of the pipeline. The protocol/panels type contract (`Card.href?: string`) is exercised by `index.test.ts`, which asserts the emitted card carries `href: '/s/<slug>/'` — so the data contract is tested even though the DOM rendering is not.

### 3. No test for service-worker `/s/*` bypass

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/sw.ts` (no test file)
- **Status:** dismissed

Brainstorm: "The service worker must let `/s/*` requests bypass caching and SPA-shell fallback — go to network unmodified." Brainstorm itself flags this as a "detail for impl"; repo has no service-worker test scaffolding.

Dismissed for the same reason as finding 2 — verified by manual testing against a real PWA install where stale SPA-shell fallback would be immediately visible. Recorded here so it is on the manual-testing checklist.

## Notes

- Tool description-content assertions (`index.test.ts`) cover the "responsive" and "secret" keywords from the architecture's mandated description text. The other architecture-required topics (two use cases, breakpoints, workflow note) are checked only loosely via `length > 200`. Not escalated — the description text is a soft contract aimed at the model, not a hard test surface.
- All test files exercise interface surfaces (`InMemoryStaticHostRegistry`, `FileStaticHostStore`, `gcStaticHostStore`, `serveStaticHostRoute`, `executeRegisterTool`, `executeRemoveTool`, `createStaticHostExtension`); no test reaches into private state or implementation details.
- No non-deterministic tests found — all time/order assertions are either explicit (`mockClear`, sequential awaits) or filesystem operations under per-test `mkdtemp` roots.
