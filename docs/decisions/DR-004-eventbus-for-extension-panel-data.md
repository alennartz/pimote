# DR-004: EventBus for Extension-to-Client Panel Data Flow

## Status

Accepted

## Context

Extensions needed to push structured data (panel cards with typed fields like color, header, body sections, footer) to pimote's web client for live display. The existing extension UI bridge was the obvious candidate — it already bridges extension state to the client via WebSocket. However, the bridge's `setWidget` API only supports `string[]` (pre-rendered text lines), and the TUI widget path uses a component factory (a function reference) which the bridge no-ops in non-TUI contexts. Structured data would have to be serialized into string lines and parsed on the client, coupling update frequency to the extension UI bridge's event flow.

## Decision

Use pi's EventBus as a direct in-memory channel between extensions and pimote's server process, bypassing the extension UI bridge entirely. The `@pimote/panels` package's `detect()` function performs a synchronous EventBus round-trip to discover whether pimote's server-side listener is present, then returns a typed `PanelHandle` (or `null`). The handle's methods emit structured messages on a dedicated EventBus channel (`pimote:panels`), which the session manager receives in-process and pushes to the client over WebSocket with its own throttling.

## Consequences

Panel data flows on a completely separate path from extension UI (dialogs, selects, confirms), so the two systems evolve independently — changes to the UI bridge don't affect panels and vice versa. Detection is synchronous and zero-cost when pimote isn't present: the EventBus emit fires, no listener responds, and the extension gets `null` with no async overhead. The trade-off is that `@pimote/panels` depends on pi's `ExtensionAPI` type for EventBus access, and the server must explicitly wire up EventBus listeners on each session (creating the bus, subscribing to detection and data channels, managing lifecycle on session reset).
