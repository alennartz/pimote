# DR-081: Server-owned tag snippets via capabilities

## Status

Accepted

## Context

The first Agent instructions editor parsed a literal `~/.config/pimote/config.json` path in the client and leniently extracted `tagSnippets`. That workaround ignored the server's XDG configuration path and duplicated validation rules. Global Settings makes the server the authority for native configuration, so connected clients need a small capability payload rather than a second config reader.

> Supersedes DR-052 (Tag snippet palette via client-side lenient parse of config.json), deleted at commit `1837a752fb599eeac0242ef4cf173c203e435f31`.

## Decision

Validate and normalize tag names in the server's shared configuration parser. Include the resulting `tagSnippets` array in `server_capabilities` on connection and after a successful native configuration reload. The client treats the payload as generic UI data, defaults to an empty palette before advertisement, and never reconstructs or reads the Pimote config path.

Rejected alternatives:

- **Keep the client-side config read.** Rejected because it breaks custom XDG paths and creates a second parser that can drift from server validation.
- **Add a tag-snippet request.** Rejected because capabilities already describe server features and can update every connected client after a native write.
- **Block the editor on malformed or missing configuration.** Rejected because snippets are a convenience; freeform tag entry and ordinary editing must remain usable without them.

## Consequences

All clients receive the same validated palette, including after a live config edit, and native configuration writes can reject invalid tag names before disk changes. The capability payload adds a small protocol field, while the editor remains independent of Pimote configuration contents and continues to work with no snippets.
