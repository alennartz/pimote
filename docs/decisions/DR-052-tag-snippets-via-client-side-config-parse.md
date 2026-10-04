# DR-052: Tag snippet palette via client-side lenient parse of config.json

## Status

Accepted

## Context

The AGENTS.md editor's toolbar offers one-tap tag-wrap snippets defined by the user as `tagSnippets` (a list of tag names) in Pimote's config file (`~/.config/pimote/config.json`). The client needs that list, but there is no server-info channel over WebSocket — nothing announces server configuration to connected clients. Adding such a channel just for a toolbar palette was rejected: it would front-run the planned server-configuration workflow, which is the right place to design how the server surfaces its resolved configuration. Blocking or failing the editor on config problems was also rejected — the palette is a convenience, never a precondition for editing.

## Decision

The client fetches the config file itself over the generic `file_get` seam (DR-051) and parses `tagSnippets` leniently: missing file, invalid JSON, or an absent key each yield no snippet buttons and never block the editor. The freeform tag input remains fully usable without snippets.

This deliberately duplicates the parse: `PimoteConfig.tagSnippets` in the server's config type documents the key and its shape, while the client's lenient re-parse is the one that actually runs. (This duplication was a review finding; the rationale is recorded here.)

## Consequences

- A custom `$XDG_CONFIG_HOME` is not honored — the client asks for the literal `~/.config/pimote/config.json` tilde path. Accepted for now; the future config workflow is the place to surface server-resolved paths.
- Invalid or hostile config content degrades to "no snippet buttons" rather than an error, by construction.
- The two parses can drift (different rules on malformed values). The server-side one is documentation; if it ever becomes live, reconcile the rules then.
- Snippet management UI (editing the palette from the client) is explicitly out of scope until the config workflow lands.
