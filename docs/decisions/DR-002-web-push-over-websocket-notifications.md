# DR-002: Web Push (VAPID) Over WebSocket-Only Notifications

## Status

Accepted

## Context

Pimote needs to notify users when background sessions finish working. The core use case is "fire off a prompt, close the app, get notified when done" — delivery must work when no active connection exists between client and server.

Two approaches were considered: Web Push via the VAPID protocol, or triggering the browser `Notification` API from WebSocket messages.

## Decision

Use VAPID-based Web Push via the `web-push` npm package. WebSocket-driven notifications were rejected because they require an active WebSocket connection — if the user closes the app or the tab, no notification can be delivered, defeating the primary use case.

Web Push delivers through the browser's push service (FCM for Chrome, Mozilla Push for Firefox) even when the app is closed and no WebSocket exists. The `web-push` package handles VAPID signing and HTTP push delivery with no external service dependencies — the server talks directly to the browser push endpoints.

## Consequences

- Requires a VAPID key pair (auto-generated on first startup, stored in server config) and persistent push subscription storage on the server.
- Adds a service worker requirement to the client PWA for receiving push events.
- The `web-push` npm package becomes a server dependency.
- Notification delivery depends on browser push services (FCM, Mozilla Push), which are reliable but outside our control — if a push service is down, notifications are delayed or lost.
- When the app is focused, the service worker posts messages to the client for in-app handling instead of showing OS notifications, avoiding redundant alerts.
