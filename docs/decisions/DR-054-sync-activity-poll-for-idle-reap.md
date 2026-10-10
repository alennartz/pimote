# DR-054: sync activity_poll for idle reap

**Status:** Proposed
**Date:** 2026-07-21
**Decider:** Alennartz
**Supersedes:** —
**Superseded by:** —

## Context

The server keeps chat server connections alive only while something is happening. If a
workspace goes idle, we want to drop it and reap it. But "nothing is happening" is hard to
observe without a signal.

## Decision

`ActivityTracker` gets an `activity_poll()`. The poll reports the "idle-since" time for
idle workspaces, the chat-server connection IDs, and the workspace list. The poll function
is shared with the liveness check.

## Alternatives Considered

1. Reuse the existing `activity_since` counter. Rejected: it does not distinguish between
   idle workspaces and busy workspaces.

## Consequences

The poll runs on a fixed interval and can be tested deterministically.

## References

- [manager-lifecycle](../plans/manager-lifecycle.md)
