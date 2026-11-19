# DR-091: Optional cached theme bridge for static reports

## Status

Accepted

## Context

Static reports open outside the PWA and can use their own CSS. Readers still benefit when a report follows the active Pimote palette, but changing the static-host contract would make authored bundles harder to reason about and could overwrite report-specific design choices. The report page also has no live session connection from which to request a catalog or profile.

## Decision

Publish one same-origin `/pwa/theme-bridge.js` helper. A report may load it after its fallback CSS. The helper discovers the current `pimote:user`, reads that user's cached resolved theme, applies the shared UI, editor, and terminal custom properties, and responds to cache or user changes from storage events. If no valid cache exists, it leaves the report's fallback styles untouched. A report's own styles can override the bridge.

We rejected rewriting report bundles at the static-host route because it would couple serving to presentation and could alter authored bytes. We rejected requiring every report to use the bridge because reports may need an independent visual language or intentionally directed styles. We rejected a network catalog request because a report should remain a lightweight static page without a session or profile handshake.

## Consequences

- General reports can adopt the user's PWA palette with one script tag and no server API call.
- Reports retain control of their CSS and continue to work when storage is unavailable or no PWA theme exists.
- The bridge must keep its cache format and custom-property names compatible with the PWA.
- Cross-tab changes apply only while the bridge lifecycle is active; stopping it removes its listeners.
- Static-host continues to serve report bundles verbatim.
