# Brainstorm: File Downloads

## Idea

Let an agent offer a file from its current project to the remote Pimote web client as a native browser download. The user approves the transfer by clicking an explicit download action rather than the agent triggering an unsolicited download.

## Key Decisions

### A download is a durable, live file registration

The send-file tool records a reference to an existing source file; it does not copy, snapshot, move, or delete that file. This avoids storage and snapshot complexity, which is not worthwhile for this use case. A click streams the file as it exists then.

A successful browser download request consumes the registration. The server can reliably observe that the request began, but cannot know whether the user later saves or cancels it, so that is the definition of acceptance. An unclicked registration remains pending.

### Registrations are session-scoped and persistent

Pending registrations persist across session and server restarts, following the existing static-host lifecycle: they restore when their owning pi session loads again, rather than becoming globally available at server boot. The source remains on the server throughout.

The agent receives a companion revoke operation so it can withdraw a pending file, including one it offered by mistake. The primary send operation remains path-focused and returns the opaque registration identity needed for revocation.

### Use direct, opaque HTTP downloads behind existing edge access

Downloads use an opaque, single-use HTTP URL rather than a WebSocket byte tunnel. That gives browsers their normal download path without adding transfer machinery that does not improve the relevant security boundary. Cloudflare Tunnel access authentication is the access boundary; a copied valid URL may be used in another browser or device while it remains valid.

The server still treats the source-path constraint as defence in depth: at registration and download time it must only serve a regular file whose resolved real path remains within the owning session's workspace. This prevents accidental path mistakes and symlink escapes, but is not claimed as confidentiality protection because an agent able to read a file could copy its contents into the workspace.

### Make pending downloads evident in the PWA

The side panel alone is insufficient on mobile. A new download should generate an immediate, actionable in-app notification and a persistent, visible downloads inbox/badge in the web client. The side panel may remain a secondary representation.

The server emits download-ready events. The client and service worker decide whether to show a system push notification based on application focus and the existing push policy, rather than the server deciding whether the user is looking at the app.

### Keep downloads distinct from static HTML hosting

File downloads belong in a separate extension because their attachment, consume-on-click, and notification semantics differ from static HTML navigation. It should reuse the static-host extension's proven session-registry, persistence, event, and route patterns where useful. Shared code should be extracted only after the common seam is clear, not through a premature generic abstraction.

### Scope is browser/PWA only

The feature covers the web client, including the installed mobile PWA. The native Android client is deliberately out of scope because native storage, download, and notification behavior would require a separate product and technical design.

## Direction

Build a dedicated, session-scoped download extension that turns an agent-provided project file path into a persistent pending registration. It exposes a direct, opaque attachment route and communicates with the PWA through a purpose-built download event so the client can present an actionable toast, downloads inbox, and focus-aware push notification. The registration is removed atomically when a browser begins a successful download and can be revoked by the agent before then.

## Open Questions

### Sharp questions for architecture

- What is the smallest reusable seam between static hosting and downloads for session-owned registration, persistence, and restart replay without conflating their distinct HTTP semantics?
- What route/registry contract atomically prevents two concurrent requests from consuming the same registration while preserving the source file?
- How should a pending registration behave when the live source becomes missing, changes type, or fails workspace real-path validation at click time?
- What shared protocol and client-store contract best represents download-ready, removal, and restored pending-download state without coupling it to generic panel cards?

### Fog

- Exact visual copy, iconography, and placement for the downloads inbox.
- Whether the inbox should expose source size and other derived metadata before the download begins.
