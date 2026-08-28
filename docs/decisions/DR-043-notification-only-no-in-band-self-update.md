# DR-043: Keep update delivery notification-only

## Status

Accepted

## Context

A one-click self-update was considered alongside the version notice. Running
`npm i -g` is not the hard part. A safe update also needs restart supervision
(systemd currently ships `Restart=on-failure`, so a clean exit does not come
back; hand-launched installs have no supervisor), install-mode detection (global
npm, `npx`, and `make install-local` clones do not share an update path), and
write-permission pre-flight on the resolved global prefix. A mid-flight failure
can leave a half-updated installation.

The risk is sharper here than in ordinary software: the process being replaced
is the operator's remote-access channel. A failed update does not merely
remove a feature; it can remove the operator's ability to reach the machine at
all, precisely when local recovery is least convenient.

## Decision

Pimote reports a newer release and links to its GitHub release tag, but never
runs an in-band package update or restarts itself. The operator updates the
installation manually at the terminal. Self-update can be reconsidered only
when supervised installs are detected with confidence, the restart path is
verified to bring the server back, and a bad release has a rollback story.

## Consequences

- The phone-to-terminal handoff and manual update remain the operator's
  responsibility; there is no transactional update/restart experience.
- A bad registry answer has the bounded blast radius of a wrong banner rather
  than a potentially unavailable server. This is what makes the simple
  unauthenticated registry lookup in DR-041 acceptable today.
- If self-update is revisited, registry-answer integrity and the rest of the
  update trust chain become materially more important; DR-041's fetch and
  caching choices must then be re-examined rather than inherited unchanged.
