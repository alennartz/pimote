# DR-017: Native Android client delegates auth to the network layer

## Status

Accepted

## Context

The native-android-client brainstorm planned an in-app Cloudflare Access OIDC flow: open a `CustomTabsIntent`, capture the `CF_Authorization` JWT from the redirect, persist it, attach it as a cookie or `cf-access-token` header to subsequent WS upgrades and speechmux `/signal` requests, and re-run the redirect on 401/302.

That plan was reconsidered during architect. Cloudflare Access is one of several deployment-time auth strategies an operator might use. Bake any one of them into the app and (a) the app ships an OIDC implementation it cannot test in CI, (b) deployments behind Tailscale, a VPN, or a LAN-only pimote suddenly need that auth machinery to no-op gracefully, and (c) the app re-implements a security boundary the operator already controls outside the app.

The PWA does not have this problem because the browser is the OIDC client — cookies are managed by the platform, not by Pimote code.

## Decision

**The native Android client makes plain HTTP and WebSocket requests to the configured pimote origin. Authentication is handled entirely at the network layer outside the app — VPN, Tailscale, LAN, Cloudflare Access running on a layer the app doesn't see, or any other operator-chosen mechanism.**

The Setup screen has a single field (pimote URL). There is no `auth/` package in `mobile/android/app/`, no `androidx.browser:browser` dependency, no Custom Tabs flow, no JWT persistence, no header injection, and no service-token concept. `WsClient` opens the WS at `${pimoteOrigin}/ws`; `SpeechmuxPeer` opens the WS at the `webrtcSignalUrl` returned by `call_bind`. Both connections are plain.

Rejected alternatives:

- **In-app OIDC via CustomTabs (the brainstorm's plan).** Couples the app to one auth strategy, ships a security-sensitive code path that's hard to exercise in unit tests, and breaks deployments that don't use Cloudflare Access.
- **Optional auth (config-driven token / header).** Doubles the surface — every request site must branch — for a feature that the operator can already provide via the network layer with no app code at all.

## Consequences

- The deployment topology must expose pimote and speechmux to the native client over an auth-free network path. This is now an explicit risk in the architecture (risk #3) and an operator-facing requirement.
- Cloudflare Access deployments cannot put the native client behind it. They must either (a) drop the Android client behind a VPN/Tailscale boundary inside the Access perimeter, or (b) revisit this decision and add an auth strategy back in.
- The app cannot be sideloaded onto an arbitrary phone and pointed at a public pimote URL. That is the intended posture for v1 — distribution is sideload / developer-mode only.
- If a future deployment topology forces auth back into the app, this DR is the entry point: replace it with a successor that records the new strategy and what changed.
