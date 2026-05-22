# DR-026: Static-host tool owns both the bundle and its panel card

## Status

Accepted

## Context

Static-resources lets an agent serve a folder at `/s/<slug>/` and surface it to the user as a tappable card in the panel. Two pieces have to come into existence together (HTTP route + panel card) and go away together (route unregistration + card removal), and they have to survive session eviction and rehydrate as a unit — otherwise users see cards pointing at routes that no longer serve, or working routes with no entry point in the UI.

The shape of the tool surface was the open question: one tool that does both, or a narrow tool that just registers the route and returns a URL, leaving the agent to compose with a separate `panels.updateCards()` call.

## Decision

A single agent tool (`pimote_static_host`) owns both halves. The static-host extension registers the HTTP route, persists the registration to per-session disk state, and emits a panel card with `href: "/s/<slug>/"` — atomically, from one tool invocation. A sibling tool (`pimote_static_host_remove`) tears both down together. Session-load replay re-registers routes and re-emits cards in one pass.

The narrow tool was rejected because card durability across session eviction is a hard problem the panel system does not solve generically: panel cards have no built-in persistence. With a narrow tool, every agent would have to re-solve durability on every session boot — observe a `session_start`, look up its own persisted state, re-emit cards. Coupling the two at the tool level lets the extension solve durability once, in one place, with state the extension already owns for HTTP-route registration.

## Consequences

- No headless "register a bundle without a card" mode in v1. If an agent wants a bundle the user can't discover through the UI, it has no way to ask for one. If a use case appears, add a second tool — don't generalise the existing one.
- The extension is the single source of truth for the bundle ↔ card pairing. Adding another way for cards to point at static-hosted bundles (e.g. an agent emitting its own card with a manually-constructed `/s/<slug>/` URL) would silently break the lifecycle guarantee — cards that survive route removal, or routes with no card. If we ever want that, it needs an explicit affordance.
- Panel cards still have no general durability story. This DR only solves it for static-host. The pattern (extension owns its panel state, replays on `session_start`) is reusable but not yet abstracted.
