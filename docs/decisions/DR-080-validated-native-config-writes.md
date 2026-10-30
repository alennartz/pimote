# DR-080: Validate native configuration writes behind the generic file seam

## Status

Accepted

## Context

The generic `file_get`/`file_put` seam deliberately uses complete-content, last-write-wins edits. Native Pimote configuration is different: a malformed write can corrupt the next boot, and a valid write can change live settings. The server must validate that one target without turning every extension-owned or Pi-native file into a Pimote-managed configuration.

> Supersedes DR-051 (Generic file-edit seam for server-side files, last-write-wins), deleted at commit `1837a752fb599eeac0242ef4cf173c203e435f31`.

## Decision

Keep the existing `file_get`/`file_put` wire shape and generic behavior for ordinary files. When a resolved target is the native Pimote configuration, the server:

- identifies the target by resolved path and by the canonical identity of existing symlink targets;
- parses and validates the candidate with the same configuration parser used at startup;
- validates before the atomic write, then applies only the supported dynamic fields;
- serializes native writes so validation and application cannot race.

`settingsFiles`, tag snippets, model defaults, idle timeout, and buffer size update for their supported future consumers. Roots, manager placement, listener port, VAPID values, and active voice transport remain startup-bound. Pi-native and third-party settings files retain ordinary last-write-wins behavior.

Rejected alternatives:

- **Add a native-config command pair.** Rejected because it would duplicate the generic file seam and force another protocol when structured settings arrive.
- **Validate in the client.** Rejected because the client cannot know the server's effective XDG paths, symlink identity, or full startup parser rules.
- **Apply generic validation to every settings file.** Rejected because Pimote does not own the schemas or reload policy of Pi-native and extension-owned files.

## Consequences

An invalid native write leaves both disk and live configuration unchanged, while an ordinary file still has the simple generic contract. Symlink aliases receive native validation and preserve the target identity through the existing atomic write helper. Dynamic fields take effect only where their consumers read a current snapshot; startup-only fields require a restart. Last-write-wins remains a deliberate trade-off for all non-native files.
