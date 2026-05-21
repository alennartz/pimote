# Static Resources

## The Idea

Let pimote serve arbitrary static HTML/asset bundles from local disk at non-root URLs, so an agent working on a project can produce an HTML report, preview, or visualization and have the user view it inside the PWA (or any browser pointed at the pimote server), then return to the main pimote UI when done.

The trigger is the agent: "make me a report of X" → agent generates HTML in some folder → agent surfaces it to the user as a tappable card in the session → user views it → user comes back to the main UI.

## Direction

Three pieces:

1. **`@pimote/panels`** — minimal change: `Card` gains one optional field, `href: string`. If set, the whole card becomes a same-tab navigating link. No `target`, no section-level links, no other interaction model.

2. **A new pi extension on the pimote server** (sibling to `server/src/voice/`), loaded into every agent session. It registers a tool with the agent that:
   - Takes a folder path (expected to contain `index.html`) plus card metadata (title, etc.).
   - Generates a slug, persists `{ slug, path, card metadata }` to session-scoped disk state.
   - Registers the HTTP route for that slug.
   - Pushes a panel card with `href: /s/<slug>/` onto the bus.
   - Returns the slug/URL to the agent.

   A companion tool removes a bundle by slug — unregistering the route and removing the card together.

3. **A new HTTP route on the pimote server** — `/s/<slug>/*` serves files from the registered folder with proper MIME types and path-traversal prevention. Same auth as the rest of pimote. The PWA service worker must pass these through (network-only, no SPA shell fallback).

## Key Decisions

### Bundles can live anywhere on disk; agent decides

No restrictions on the path the agent points at. The pimote server already runs as the user, so this isn't a privilege boundary — exposing those files over HTTP is the only new surface, and the same auth covers it.

### Hosting and panel card share one lifecycle, owned by one extension

The static-serve tool both registers the bundle AND creates its panel card in a single call. The same extension owns both, so they're guaranteed coupled: created together, removed together, persisted together.

Rationale: the alternative (narrow tool that just returns a URL; agent composes with a separate `panels.updateCards()` call) forces the agent to re-solve card durability on every session boot, which is awful UX. Coupling them at the tool level fixes it in one place.

### Bundles persist across session eviction and rehydration

When the agent registers a bundle, the extension writes its state to session-scoped disk storage. When the session is evicted from memory (no clients, timeout elapsed), the HTTP routes stop serving. When the session is rehydrated (client reconnects), the extension replays its state: re-registers the HTTP routes and re-pushes the panel cards. This matches the existing pattern (e.g. sub-agents) where extensions are responsible for replaying their own state on session load — panel cards do not have general durability today, and this work does not add it.

Bundles are torn down permanently when the session is permanently destroyed.

### Card-level clickability only, same-tab navigation

`href` on `Card` makes the whole card a same-tab link. No `target` field, no section-level links. The "navigate away, then browser-back to return" flow matches the user's mental model for the static-report case, and external links can still get new-tab behavior via long-press / middle-click. If section-level links or explicit new-tab become real needs, add them later.

Hrefs are unconstrained strings — internal `/s/<slug>/` URLs, external `https://...`, or anything else.

### Tool always creates a panel card

No "register a bundle and just return the URL" mode in v1. If the agent wants the user to find the bundle, it needs to be discoverable, and a card in the session is the only mechanism. If a use case for headless bundle registration appears later, add a second tool.

### Same-origin security: accepted risk

Bundles are served from the same origin as the pimote app, so JS in a bundle can in principle reach pimote's API/WS endpoints with the user's auth. Threat model is "user's own trusted agent on user's own machine" — accepted risk for v1. No CSP, no subdomain isolation. If pimote later supports multi-user or untrusted-agent scenarios, revisit.

## Open Questions

- **Slug format** — random short ID, human-readable derived from folder name, or hybrid. Leaving for architect.
- **Exact tool names and parameter shapes** — leaving for architect.
- **Where session-scoped disk state lives** — should align with existing session persistence on disk. Leaving for architect.
- **PWA service worker configuration** — `/s/*` must bypass the SPA fallback so the service worker doesn't serve the app shell for these paths. Detail for impl.
- **Browser back-button UX** — after the user navigates to `/s/<slug>/` and hits back, do they return cleanly to the same session/tab state? Likely yes via standard browser history, but worth verifying during implementation; might need a small client-side affordance.
