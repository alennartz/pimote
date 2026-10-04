# DR-051: Generic file-edit seam for server-side files, last-write-wins

## Status

Accepted

## Context

The AGENTS.md editor is the first pimote UI feature that reads and writes a server-side file (`~/.pi/agent/AGENTS.md`) on the user's behalf. It needed a read/write seam in the wire protocol, and the shape of that seam would either enable or block the planned server-configuration workflow that this feature is intended to be the first citizen of.

A feature-specific command pair (e.g. `agents_md_get`/`agents_md_put`) was rejected: it would hard-code one file into the protocol and force a second, incompatible seam when the config workflow arrives. Optimistic concurrency — an mtime or hash version token with a "changed on disk" prompt — was proposed and explicitly rejected as over-engineering: the operator is the only realistic writer of these files and accepts the risk of their own concurrent edits. A path allowlist was rejected per DR-050's posture: the server already trusts its own operator with server-readable/writable paths, and the agent can already read and write these files under its runtime permissions.

## Decision

Add a session-independent `file_get` / `file_put` command pair carrying nothing but a path and the file's complete content — "just a file edit with path and content", deliberately generic.

- A leading `~`/`~/` expands to the server's home directory; anything else resolves as-is. Empty paths error.
- `file_get` on a missing file succeeds with `exists: false` and empty content; directories, unreadable files, and non-UTF-8 reads fail.
- `file_put` creates parent directories and writes atomically (temp file + rename), creating the file when missing. The write follows symlink chains to the real target and copies the existing permission bits onto the temp file, so a config file keeps its identity across a save.
- Saves are plain last-write-wins. No versioning, no conflict detection.

Scope stays one file at the product layer (the home-page button targets exactly `~/.pi/agent/AGENTS.md`); only the seam is generic. The Android protocol mirror is not extended — its staleness is accepted debt; this feature is PWA-only.

## Consequences

- The future server-configuration workflow can adopt the seam unchanged; other config files become reachable by pointing the same dialog at a different path.
- Concurrent-writer edits are silently lost. Only acceptable while the operator is the sole writer; revisit if agent-driven config edits ever become a thing.
- Relative paths resolve against the server's working directory, and `~user/...` counts as relative and lands under `<cwd>/~user/...` — surprising but consistent with the documented contract.
- Atomic rename would otherwise break symlinks and reset permissions, hence the real-path resolution and mode copy. File ownership is not preserved (the renamed file belongs to the server's user) — acceptable unless the server runs as a different user than the file owner.
- The client must not treat a save as safe until a load has completed, or a failed load can blank the file on save.
