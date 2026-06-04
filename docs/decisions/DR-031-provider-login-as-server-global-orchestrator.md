# DR-031: Provider login as a server-global orchestrator, decoupled from sessions

## Status

Accepted

## Context

pimote needed a `/login` equivalent to the pi TUI's: an interactive flow,
driven from the PWA, for logging into OAuth subscription model providers
(Claude Pro/Max, ChatGPT, GitHub Copilot) so a remote operator can add a
provider without SSHing into the server or hand-editing `auth.json`.

The credential machinery already existed end to end: `session-manager.ts`
constructs **one** shared `AuthStorage.create()` plus a `ModelRegistry`,
threaded into every pi session. Storage and consumption of credentials worked
already — the only gap was running the interactive login (`authStorage.login(id,
callbacks)`) remotely. The open question was where that orchestration should
live. The natural-looking option was to hang it off session handling, since
that's where most client commands route (through `handleSessionCommand`, which
requires a `sessionId`).

## Decision

Login lives in its own server singleton, `LoginOrchestrator`
(`server/src/login-orchestrator.ts`), owned by `PimoteSessionManager` alongside
the shared `AuthStorage` + `ModelRegistry` it already holds. `ws-handler` routes
the four `login_*` commands as **global** commands at the top-level switch,
deliberately _not_ through `handleSessionCommand` — they carry no `sessionId`.
The orchestrator lists OAuth providers, runs a single login flow at a time
(in-flight busy guard), and translates pi's `OAuthLoginCallbacks` into typed
protocol steps over a connection-bound transport.

The driving reason: **auth is server-global state, not per-session.** There is
one `AuthStorage` shared by all sessions and all connected clients, so `/login`
mutates global server state. Tying the login flow's lifetime and ownership to
any one session would be a category error — the operation has nothing to do with
a particular session's lifecycle, and a session can come and go mid-flow without
any bearing on the login.

## Consequences

- The orchestrator's lifetime is the server's, independent of any session. A
  login can run with no session open; closing a session does not disturb an
  in-flight login.
- The four `login_*` commands had to be added to the top-level command switch
  explicitly so they bypass the session-routing path. A future contributor
  adding session-scoped behavior must not assume all commands flow through
  `handleSessionCommand`.
- Single-flight is global, not per-session or per-provider: a second
  `login_begin` while one is in flight is rejected `{ ok:false, reason:'busy' }`.
  Acceptable for a single-operator system; if multi-operator concurrent logins
  ever mattered, this is the constraint to revisit.
- The transport is connection-bound even though the orchestrator is global: only
  the initiating connection receives `login_step` events and resolves inputs, so
  the flow's UI stays with the client that started it.
