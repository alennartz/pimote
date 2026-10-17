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

The harness uses fabricated pi session JSONL and a local server. It exercises the real WebSocket handlers, event buffer, archive metadata, PWA, and voice holder seam, but it does not run a live LLM or speechmux. Queued-send acceptance and order are observed at the wire boundary. A local `ws` server keeps the voice leg open without speech processing. The external-process check uses a Node process whose command line contains `pi-coding-agent`; it validates Pimote's `/proc` detector but not a real pi runtime. The dialog path uses a temporary global pi extension that calls the shipped UI bridge from a deterministic user-bash hook. These seams weaken only live-provider, real speech, and real third-party extension coverage.

## Results

### Smoke Suite

- **Journey 1 — Connect and open a session:** `npm run build`; the smoke opened the seeded session through two `WsProbe` clients and the PWA. Both probes received the transcript replay. **Pass.** The session view showed the seeded messages, status controls, composer, and no takeover surface. Looks coherent.
- **Journey 2 — Prompt and bash output:** the smoke submitted queued sends from both observers, executed native bash, observed cursor-free live deltas, and opened a late observer after completion. The late observer replay contained the final bash result. **Pass.** Live output and the settled bash block remain consistent with the transcript. Looks coherent.
- **Journey 3 — Extension UI bridge:** the temporary `user_bash` extension opened one confirm request. Both observers received it; the first answer resolved the extension and dismissed only the other copy. A later answer produced no second dismissal. **Pass.** The first-answer-wins behavior is coherent across observers.
- **Journey 4 — Shared session observers:** two probes opened one runtime; either sent; disconnecting one left the other attached; archive sent `session_closed { reason: "archived" }` and `session_archived` to every observer; unarchive left the runtime closed until a soft open. **Pass.** The dashboard and session surfaces show one shared session without owner or takeover language. Looks coherent.
- **Journey 8 — Voice call:** a local WebSocket stand-in kept the voice extension active. The first bind succeeded, the second failed with `call_bind_failed_owned`, forced transfer sent `call_ended { reason: "displaced" }` only to the old holder, and the session stayed open. **Pass.** Call ownership is isolated from session observation. Looks coherent.

### Topic-Specific Tests

1. **Observer fan-out and sends:** two observers received the same replay; two queued sends appeared in arrival order, and either observer sent after the other disconnected. **Pass.** Shared transcript and command surface are coherent.
2. **Disconnect retention:** closing one probe did not remove the remaining observer. **Pass.** The remaining client continued to send.
3. **Archive and explicit unarchive:** every observer received the archived close and archive notification; unarchive did not reopen; a soft open did. **Pass.** Archive state and live runtime state remain separate.
4. **Stale archived restore:** a stale probe received `session_archived`; the browser boot path removed the injected `pimote:activeSessions` entry. **Pass.** Archived sessions stop boot loops.
5. **Dialog resolution:** matching `extension_ui_resolved` reached the non-answering observer; unknown or late responses did nothing. **Pass.** Dialog copies converge without duplicate answers.
6. **Bash output:** connected observers received live deltas without cursors; the late observer received only the final result in replay. **Pass.** Streaming and replay boundaries are coherent.
7. **Voice holder:** no-force bind rejected the second caller; forced transfer targeted the old holder; no session close occurred. **Pass.** Voice transfer does not masquerade as session displacement.
8. **External conflict:** a pi-like process in the folder produced `session_conflict` without `remoteSessions`. **Pass.** The conflict warning remains folder-scoped.
9. **Ownership vocabulary:** browser snapshots and page text contained no `Take Over`, `session owned`, or remote-owner presentation. **Pass.** The observer UI is coherent and owner-free.

## Plan Updates

- None. Journey 4 already describes shared observers in `tools/manual-test/PLAN.md`.

## Open Issues

None.
