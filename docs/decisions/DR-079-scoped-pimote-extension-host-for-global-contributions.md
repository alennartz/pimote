# DR-079: Scoped Pimote extension host for global contributions

## Status

Accepted

## Context

Pimote's earlier jiti loader treated discovery sources and folder creators as one symmetric project-level extension seam. Global Settings needs a server-wide source and settings registry, while Pi extensions remain session-scoped. Loading project-local packages or every Pi extension would mix those scopes and give unrelated modules a second lifecycle. Reload also needs to retire registrations and await cleanup without restarting the server.

> Supersedes DR-049 (Trusted in-process TypeScript project sources via jiti), deleted at commit `7a525cb95e37c9a30ef5dc3e52d73a65fc13b37d`.

## Decision

Use a dedicated, trusted in-process Pimote extension host for server-global contributions.

- Discover direct JavaScript/TypeScript modules and entry-bearing directories under the user's Pimote extensions directory.
- Adapt only user-scoped Pi packages that declare `pimote.extensions`. Ignore project packages and `pi.extensions`; those belong to Pi's session host.
- Run one default factory per discovered entry. Its context can register `FolderSource` values, settings files, and asynchronous shutdown handlers. Relative settings paths resolve from the entry module.
- On startup and server-wide reload, await the old runtime's shutdown handlers, invalidate its context, clear the jiti cache, and install a fresh registry. Serialize lifecycle operations, isolate entry failures, and publish diagnostics. Replace user sources atomically while preserving core sources. Keep folder creation in Pimote core rather than exposing an external creator registration seam.

Rejected alternatives:

- **Keep one symmetric source-and-creator loader.** Rejected because custom creators would bypass the core folder wizard's invariants, and the loader would still mix project discovery with server-global settings.
- **Pass all Pi entries or scan project-local packages.** Rejected because session extensions would gain global effects and project configuration would alter the server-wide registry.
- **Restart the server for every extension change.** Rejected because source and settings contributions need an explicit `/reload` boundary without dropping active sessions.
- **Sandbox or move modules out of process.** Rejected because the operator already trusts in-process Pi extensions, and isolation would add deployment and lifecycle cost without protecting that operator.

## Consequences

Extension code runs with server privileges, as the operator's trusted Pi extensions do. A user-level package declaration enables its Pimote contribution without a second install step, and the same package can declare independent Pi and Pimote entries. Reloads are deterministic and remove stale registrations, but a hanging shutdown handler can delay a reload. Built-in code, persona, and hub creation remain stable core behavior; extension authors provide discovery sources and settings files, not creators.
