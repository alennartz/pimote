# DR-049: Trusted in-process TypeScript project sources via jiti

## Status

Accepted

## Context

Project discovery and project creation both had to be extensible from day one: users named custom discovery sources (workspaces-file, zoxide/ghq) and custom creation flows (template scaffolding, `gh repo clone`) as the extensibility use cases, then extended the requirement to "discovery equal to creation." The modules should be authorable in TypeScript, exactly like pi extensions. Node's native `import()` cannot load `.ts` files, and pi itself loads TypeScript extensions through jiti.

## Decision

Discovery sources and creators are symmetric in-process extension modules:

- `ProjectSource` (discovery) and `ProjectCreator` (creation) interfaces; the built-in filesystem walker and mkdir/git-init creator ship alongside user modules.
- User modules are `.js`/`.mjs`/`.cjs`/`.ts` files in a configured directory (default `~/.pimote/project-sources/`), loaded at boot through jiti (`createJiti(import.meta.url)`, mirroring pi's own `jiti-loader`). jiti is a direct server dependency for this reason.
- Failures are isolated per module: a module that throws or fails to parse logs a warning and is skipped; the scan continues.
- No sandboxing in v1 — user-authored code is trusted, consistent with pi's extension model. Modules export `sources` / `creators` arrays; everything else in the directory is ignored.

Rejected alternatives:

- **JS-only modules loaded with native `import()`.** Rejected: breaks the TypeScript authoring story that matches pi extensions, the stated user expectation.
- **Out-of-process execution / plugin sandboxing.** Rejected as premature and inconsistent: pimote already trusts in-process pi extensions with far more reach; a project-source sandbox would be security theater against an operator who controls the server anyway.

## Consequences

- A malicious project-source module runs with full server privileges. This is accepted under the same trust model as pi extensions: the person who configures the sources directory owns the server.
- Modules load once at boot; there is no hot reload — adding or changing a source requires a server restart.
- jiti joins the direct dependency set (previously only a hoisted transitive of the pi SDK); its loading semantics (no persistent module cache) match pi's behavior.
- The per-module failure isolation bounds blast radius to one broken module, but a module that hangs (rather than throws) still blocks the load loop.
