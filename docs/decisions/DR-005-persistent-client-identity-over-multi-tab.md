# DR-005: Persistent Client Identity Over Multi-Tab Support

## Status

Accepted

## Context

Pimote used ephemeral in-memory client IDs (`crypto.randomUUID()` on every page load) to allow multiple browser tabs to independently own different sessions without conflicting. Adding session persistence required a stable client identity across page reloads, which means storing the clientId in localStorage — but localStorage is shared across all tabs in the same origin, so two tabs would share the same identity and compete for session ownership.

## Decision

Persist the client ID in localStorage, accepting that multi-tab usage in the same browser is no longer supported. Persistent identity was chosen because session restore (surviving page reloads and browser restarts) is a higher-value use case than multi-tab usage, and the two are mutually exclusive with localStorage-based persistence. The existing takeover UI handles ownership conflicts gracefully when two tabs do collide, but it's disruptive rather than seamless.

## Consequences

Session restore works seamlessly — the server recognizes the same client across app restarts, and session ownership, push subscriptions, and takeover logic all work without re-establishing identity. Multi-tab usage in the same browser causes ownership conflicts. If multi-tab support becomes important in the future, it would require a different persistence mechanism (e.g., per-tab sessionStorage with a shared localStorage coordinator, or BroadcastChannel-based tab leadership election).
