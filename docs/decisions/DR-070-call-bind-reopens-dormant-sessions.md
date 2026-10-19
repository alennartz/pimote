# DR-070: Reopen dormant sessions server-side on call_bind

## Status

Accepted

## Context

The Android client dials sessions from a contact list built from `list_sessions` disk records, without opening them. `call_bind` required a live in-memory slot, so any idle-reaped session — 30 minutes unobserved by default — failed with `call_bind_failed_session_not_found`, a definitive code with no client recovery. The PWA never hits this because it calls the session it is viewing.

The fix had two possible homes. Client-side, Android could bracket each call with `open_session`, but the disk-reopen path syncs the full transcript to the calling client, and ending the bracket cleanly is impossible with the current vocabulary: `close_session` closes the session for every observer, so it cannot serve as a detach, while staying attached pins every called session in memory behind the always-on Android socket. Doing it properly would require a new detach-only wire command.

## Decision

When `call_bind` finds no live slot, the server resolves the session record across known folders and reopens the session from disk for the call. No observer attaches and no transcript syncs. Extensions bind on the reopened slot — the voice extension subscribes to `pimote:voice:activate` at extension bind, which until now was first-observer work — so the orchestrator's activation finds its listener with zero observers. The DR-069 call-holder reap guard holds the session only while the call is active; idle reaping reclaims it afterwards.

A missing or archived record keeps returning `call_bind_failed_session_not_found` as a definitive code; a reopen failure (corrupt file, failing open hooks) maps to `call_bind_failed_internal`. A sidebar update broadcast accompanies the reopen so folder active-session counts stay honest.

## Consequences

- Thin clients can call any unarchived session without opening it; the server stays the sole owner of session lifetime.
- Extension binding gains a zero-observer caller. The UI bridge parks requests no observer will deliver, and voice mode rejects UI bridge calls outright, so no request can hang a voice-only session.
- A failed bind resolves the record across known folders — the same cost class as a folderless `open_session` deep link, paid once per failed bind.
- Android still owns one client-side half: mapping `call_bind_failed_session_not_found` to a "session gone" failure and dropping the stale contact row.
