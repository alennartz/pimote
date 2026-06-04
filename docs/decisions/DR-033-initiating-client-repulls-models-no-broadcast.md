# DR-033: Initiating client re-pulls models after login; no server broadcast

## Status

Accepted

## Context

A successful `/login` lands a new credential in the shared `AuthStorage` and
calls `modelRegistry.refresh()`, so new models become available server-side. The
question was how connected clients' model pickers learn about the new provider.
The server _could_ broadcast an updated model list to every connected client/
session so all pickers refresh immediately. The alternative was to have only the
client that ran the login re-pull the list.

## Decision

On a terminal `login_step {kind:'done', success:true}`, the initiating client
re-issues the existing `get_available_models` command for the session it is
currently viewing; the model picker then reflects the new provider. No
server-side broadcast is added.

The accepted trade-off, stated explicitly: **other connected clients/sessions
stay stale** until their next natural pull — e.g. reopening the model picker,
switching sessions, or reconnecting. This is intentional for a single-operator
system. A server broadcast path was considered and rejected as unjustified
complexity: it would mean wiring a new push event, tracking which connections
care, and fanning out registry changes — real machinery to keep N clients in
sync when in practice there is one operator who just completed the login in the
one client that matters.

## Consequences

- The operator who ran the login sees the new models immediately in their viewed
  session; that's the only client that needs to.
- Any _other_ open client, or another session in the same client, will not show
  the new provider until it next pulls the model list. This is a known,
  accepted staleness window, not a bug.
- Re-pull is skipped entirely when no session is viewed (nothing to refresh) and
  on `done{success:false}` (nothing changed). Login itself is global and never
  opens or touches a session.
- If pimote ever becomes genuinely multi-operator or multi-client-concurrent, the
  rejected broadcast path is the thing to revisit — the re-pull hook is a
  client-local stopgap that depends on the single-operator assumption.
