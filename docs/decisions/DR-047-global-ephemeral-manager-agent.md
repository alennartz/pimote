# DR-047: The manager agent is global and ephemeral

## Status

Accepted

## Context

The dashboard embed a manager agent — one agent spanning all projects and the whole session space, reached from the home surface rather than from inside any session. The open design questions were its scope (global vs per-project) and lifetime (persistent vs ephemeral). The user initially wanted non-persistent, briefly reconsidered a persistent manager with memory, then settled on ephemeral.

## Decision

One global manager per WebSocket connection, never persisted:

- Created on first manager use for that connection, built on the SDK's `SessionManager.inMemory` with an empty temp working directory, disposed on disconnect. An idle reaper (30-minute timeout, swept every minute) is a leak safety net, not the primary lifecycle.
- No session file, no replay cursor, no cross-visit memory. The manager is a command surface, not a colleague with memory — transcript resets when the connection drops, and a reconnect gets a fresh manager.
- Its tools act only through injected pimote server API ports (narrow ports per DR-039: session-manager, ProjectRegistry, RepoIndex), never raw fs or server internals.

The persistent variant was rejected because it would drag in the full session-lifecycle machinery (files, replay, resume) for a surface whose value is "ask, act, done" — simpler plumbing won, and nothing in the manager's role requires remembering previous visits. Per-project managers were rejected as redundant: the global one already reaches every project through its toolset.

## Consequences

- Manager transcripts are connection-scoped: a reload loses the conversation, by design. Anything worth keeping must be turned into durable state (projects, sessions) through the tools.
- Per-connection lifecycle costs a temp dir + runtime per active dashboard client; the reaper bounds leaks from clients that vanish without a clean disconnect.
- The toolset is the manager's entire capability surface — growing it means growing the injected ports, which keeps server internals out of reach by construction.
- Ephemeral sessions make manager output cheaper to stream (no replay), but also mean there is no audit trail of manager actions beyond what its tools changed.
