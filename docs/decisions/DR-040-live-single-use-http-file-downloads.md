# DR-040: Use live, single-use HTTP registrations for file downloads

## Status

Accepted

## Context

Pimote needed a way for an agent to make a project file available to the remote user without turning an agent action into an unsolicited transfer. The browser already has a safe, familiar download flow, but the server must bridge an agent-provided path to that flow while preserving session ownership, restart recovery, and one-time acceptance. A pending offer also has to remain useful when the source file changes between the offer and the user's click.

The main alternatives were to copy or snapshot the file when the agent offers it, tunnel file bytes over the WebSocket connection, or expose the path through the static-host route. Copying would require a second storage lifecycle and could consume substantial disk space for files the user never accepts; a WebSocket transfer would duplicate browser download machinery and introduce resumability/backpressure concerns; static hosting has navigation semantics rather than consume-on-click attachment semantics and would conflate two unrelated extension lifecycles.

## Decision

Represent an offer as a persistent, session-scoped registration that points at the existing source file. The server gives the PWA an opaque, high-entropy `/d/<id>` URL. A `GET` claims the registration before opening the source, durably removes it, and streams the file as a native attachment. The source is never copied, moved, or deleted; the bytes are read as the file exists at click time. A registration can be revoked by its owning agent before it is claimed, and a successful claim consumes it even if the later stream fails.

The opaque URL is a single-use capability, not a browser- or session-bound authorization mechanism. Existing Cloudflare Tunnel/edge access remains the access boundary, so a copied unused URL may be redeemed from another browser or device that can pass that edge access. Registration-time and click-time real-path containment checks are defence in depth against path mistakes and symlink escapes, not a confidentiality guarantee against an agent that can already read and copy the file.

Download offers are a browser/PWA surface only in this version. Push notifications carry presentation metadata and an instruction to open the owning session's Downloads inbox; they never carry or automatically follow the one-shot URL. This preserves an explicit user click as the acceptance boundary and avoids consuming a pending registration merely because an operating system delivered a notification.

## Consequences

- Pending registrations need per-session persistence and replay, plus atomic claim reservation and removal, rather than a simple in-memory map.
- The route must validate the live source again after claiming. Missing, replaced, non-regular, or out-of-root sources produce an error while remaining consumed; v1 does not attempt to restore a failed registration.
- Users get normal browser attachment behavior and the source file remains untouched, but the server does not know whether the browser ultimately saved or cancelled the download after the request began.
- A copied URL can be used by any client admitted by the existing edge access layer until its first successful claim. Stronger browser/session binding would require a separate authorization design and would change the intended cross-device behavior.
- The Android client does not receive a download protocol or storage surface. Adding native downloads later should be evaluated as a separate product decision rather than extending this browser-specific contract implicitly.
