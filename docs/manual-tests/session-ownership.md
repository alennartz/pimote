# Manual Testing — session-ownership

## Smoke Suite

This run exercises the primary journeys changed by the session-ownership redesign:

- **Journey 1 — Connect and open a session:** two clients open one seeded session, including a stale archived restore attempt.
- **Journey 2 — Prompt and bash output:** either observer sends commands; live bash output fans out and a late observer receives the final result.
- **Journey 3 — Extension UI bridge:** one observer answers a dialog and the other copy closes.
- **Journey 4 — Shared session observers:** simultaneous observers, archive fan-out, explicit unarchive, and disconnect cleanup.
- **Journey 8 — Voice call:** one call holder, rejected second bind, forced transfer, and targeted `call_ended`.

Unchanged dashboard, folder, provider-login, download, and Android journeys are out of scope for this topic.

## Topic-Specific Tests

1. Two observers open the same live session. Both receive transcript events and either client can submit a prompt.
2. Observer sends queue in arrival order and disconnecting one observer leaves the other attached.
3. Archive closes every observer with `session_closed { reason: "archived" }`; unarchive changes metadata only and does not reopen the slot.
4. A stale client with the archived session in local storage receives `session_archived`, keeps its transcript, and removes the session from its restore set.
5. Extension dialogs broadcast to all observers; the first response wins and dismisses matching copies on other clients.
6. Live bash deltas reach all observers without advancing replay cursors; a late joiner receives the final persisted result.
7. A voice call has one holder. A second bind is rejected unless forced; forced transfer sends `call_ended { reason: "displaced" }` only to the old holder.
8. An external pi-like process in the session folder produces `session_conflict` without remote-session ownership records.
9. Session and conflict surfaces contain no ownership or takeover UI or vocabulary.

## Tools

- Reused: `tools/manual-test/lib/sandbox.mjs`, `tools/manual-test/lib/ws-probe.mjs`, and `tools/manual-test/lib/browser.mjs`.
- New: `tools/manual-test/session-observers-smoke/session-observers-smoke.mjs` for the real server, two WebSocket observers, and two agent-browser sessions.

## Harness Limitations

The harness uses fabricated pi session JSONL and a local server. It exercises the real WebSocket handlers, event buffer, archive metadata, PWA, and voice holder seam, but it does not run a live LLM or speechmux. Prompt acceptance and queue order are observed at the wire boundary. The external-process check uses a detached Node process whose command line contains `pi-coding-agent`; it validates Pimote's `/proc` detector but not a real pi runtime. Browser dialogs require a fixture extension and are therefore checked through the protocol pending-UI seam when no shipped extension can trigger one.

## Results

_To be filled after execution._

## Plan Updates

- Add the shared-observer journey to `tools/manual-test/PLAN.md` if this run confirms it as a stable primary path.

## Open Issues

_To be filled after execution._
