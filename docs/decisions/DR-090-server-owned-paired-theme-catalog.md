# DR-090: Server-owned catalog for paired web themes

## Status

Accepted

## Context

Theme data has three owners: Pimote's built-in palettes, extension-provided files, and the host user's custom file. Letting each client assemble those sources would duplicate validation and inheritance rules, expose inconsistent catalogs across devices, and put a large palette payload in the shared connection capabilities used by Android. A saved theme also needs to follow a Pimote username while remaining usable when an extension or user file disappears.

The UI and editor colors must change together, but their roles differ. A single flat color list would force application chrome and code rendering to share vocabulary, while separate independent settings would let the two surfaces drift.

## Decision

The server owns a `ThemeCatalog` that resolves paired UI, editor, and terminal palettes. It loads built-ins first, registered extension files in deterministic discovery order, and the user file last. The first valid definition for an ID wins; built-in IDs are reserved. The catalog validates colors and structure, resolves named swatches and inheritance, isolates invalid entries, retains the last valid user contribution, and publishes revisions for source or default changes.

The PWA requests a catalog snapshot through a PWA-specific command and refreshes after a revision-only event. Android receives neither the catalog nor theme payloads. A profile stores one `selectedThemeId` or `null`; `null` follows the live native `defaultTheme`. If a saved or configured theme is unavailable, rendering falls back to Pimote Light without erasing the saved choice. The existing per-user profile event propagates a saved choice to that user's connections.

We rejected client-side source merging because it would duplicate parsing, precedence, and fallback behavior. We rejected putting the catalog in `server_capabilities` because Android does not need the data and every connection would pay its cost. We rejected separate UI and editor selections because a theme is a deliberate paired preset.

## Consequences

- One server boundary defines catalog validity and source precedence for every PWA connection.
- Extension and user files can extend one another without changing the client protocol.
- Theme catalogs can change at runtime, but clients must handle revision notifications and re-request snapshots.
- A missing theme never makes the PWA unusable, but a saved unavailable ID can remain until its owner repairs or replaces the source.
- Android keeps its existing protocol subset and does not implement theme rendering.
