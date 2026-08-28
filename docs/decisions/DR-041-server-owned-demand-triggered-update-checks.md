# DR-041: Use server-owned, demand-triggered update checks

## Status

Accepted

## Context

Pimote needs to tell a self-hosted operator when a newer `@pimote/pimote` is
published. The PWA could query npm directly, but that would make each device
phone home independently, make air-gapped and tunnel-only deployments behave
differently from the rest of the product, and compare against a version the
client does not own. The server already knows the installed version and is the
natural boundary for one host-wide registry policy. Because pimote bundles pi
as a dependency, a new pi release reaches an operator only through a new
pimote release; this notice therefore also signals when the bundled pi is
stale.

After the server learns a newer version, it could poll on a timer and fan the
result out to every connected client, or it could check when a client connects.
DR-033 established that this is a single-operator system where broadcast
machinery is not justified; this decision applies that same principle to update
status rather than superseding it.

## Decision

The server owns npm access, semver comparison, and release-link construction.
It keeps a process-lifetime cache of both update and no-update results, limits
refreshes to a six-hour TTL, coalesces concurrent refreshes into one
single-flight request, and suppresses registry failures. The registry adapter
has a ten-second deadline so a hung socket cannot leave the single-flight
promise pending for the life of the process. The comparison is strictly
`latest > current`, not merely unequal.

One checker is warmed at startup and consulted on each accepted WebSocket
connection; a non-null result is sent only to that connection. There is no
polling timer or server fanout. With no fanout consumer for a discovery made in
the background, a scheduled check would add work without delivering it; a
connect-triggered refresh gives the cache a consumer exactly when needed. The
`updateCheck: false` configuration disables construction, warm-up, and registry
access entirely.

## Consequences

- A host makes at most one registry request per cache window, and all of its
  clients receive the same version truth. Registry failures remain silent and
  preserve any previous cached status.
- A client that stays connected for days can remain stale until it reconnects
  or reloads. This is the accepted single-operator trade-off from DR-033; a
  future multi-operator or real-time requirement would be the point to revisit
  fanout and a lifecycle poller.
- Strict greater-than prevents a development or `install-local` build that is
  ahead of npm from displaying a phantom update.
- The deadline prevents a stalled npm/proxy connection from permanently
  wedging the checker; a timeout is treated like any other refresh failure.
- Deployments that must not make outbound requests can opt out with
  `updateCheck: false`, at the cost of receiving no update status or reminder.
