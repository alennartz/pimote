# Settings and configuration

Pimote has two configuration surfaces. The **native config** is Pimote's own JSON file. The **global Settings catalog** is the set of instruction and settings files the dashboard edits. This page describes both, plus what each native field changes and when it applies.

Project-scoped pi settings never appear in the catalog. Use pi's own `.pi` files for those.

## Native config

The file is `$XDG_CONFIG_HOME/pimote/config.json`, which defaults to `~/.config/pimote/config.json`. `roots` is the only required field.

```json
{
  "roots": ["/srv/repos"],
  "managerRoot": "/srv/pimote/manager",
  "port": 3000
}
```

| Field                                                 | Type                            | Default                          | Effect                                                                     |
| ----------------------------------------------------- | ------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `roots`                                               | string[]                        | required                         | Scan roots for folder discovery.                                           |
| `managerRoot`                                         | string                          | `$XDG_STATE_HOME/pimote/manager` | Working directory of the manager session. A leading `~` expands.           |
| `port`                                                | number                          | `3000`                           | HTTP listen port.                                                          |
| `appName`                                             | string                          | `Pimote`                         | Display name for the tab title and the installed PWA.                      |
| `idleTimeout`                                         | number                          | `1800000`                        | Milliseconds before the reaper closes an idle session.                     |
| `bufferSize`                                          | number                          | `1000`                           | Events retained per session replay buffer.                                 |
| `defaultProvider`, `defaultModel`                     | string                          | automatic                        | Model for each new session.                                                |
| `defaultThinkingLevel`                                | string                          | automatic                        | Thinking level for each new session.                                       |
| `defaultInterpreterModel`                             | string or `{provider, modelId}` | automatic                        | Voice interpreter model; the slug form accepts a `:level` thinking suffix. |
| `defaultWorkerModel`                                  | string or `{provider, modelId}` | automatic                        | Voice worker model; the slug form accepts a `:level` thinking suffix.      |
| `voice.speechmuxSignalUrl`, `voice.speechmuxLlmWsUrl` | string                          | none                             | Voice signalling and interpreter endpoints.                                |
| `settingsFiles`                                       | string[]                        | none                             | Extra files in the global Settings catalog.                                |
| `tagSnippets`                                         | string[]                        | none                             | Wrap-tag palette in the `AGENTS.md` editor.                                |
| `updateCheck`                                         | boolean                         | `true`                           | Check npm for newer releases.                                              |
| `vapidPublicKey`, `vapidPrivateKey`, `vapidEmail`     | string                          | generated at first boot          | Web push credentials.                                                      |

`folderSourcesDir` is a legacy field. The extension host ignores it.

### Validation

The server rejects a native config write, and leaves the file unchanged, when:

- the JSON does not parse, or is not an object;
- `roots` is not a non-empty array of strings;
- `managerRoot` is set and is not a non-empty string;
- `settingsFiles` or `tagSnippets` is not an array of strings;
- a `tagSnippets` entry does not match `^[A-Za-z][A-Za-z0-9_-]*$`.

A field with the wrong type falls back to its default. Only the cases above fail the write.

`tagSnippets` keeps the first occurrence of each name, and the server advertises the result to clients.

### When a change applies

| Field                                                                         | Applies                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `settingsFiles`, `tagSnippets`                                                | At once.                                                   |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`                     | To the next new session.                                   |
| `defaultInterpreterModel`, `defaultWorkerModel`                               | To the next voice extension build.                         |
| `idleTimeout`                                                                 | At the next reaper check.                                  |
| `bufferSize`                                                                  | To new session buffers, including reset and fork rebuilds. |
| `roots`, `managerRoot`, `port`, `appName`, `voice`, VAPID keys, `updateCheck` | Only at restart.                                           |

A write to a startup-only field succeeds and changes nothing until the server restarts. Restart the server after such a change.

### Manager root placement

The manager root must not be the home directory or contain it. Pimote seeds a persona `AGENTS.md` there, and pi loads every ancestor `AGENTS.md` into a session, so a manager root above the home directory would steer every pi session on the machine.

Pimote refuses to boot in that case. A manager root inside a scan root is legal, because the listing drops its row.

## Global Settings catalog

The catalog lists the files the dashboard Settings view edits. The server builds it on every request and resolves every path, so the client never reconstructs a host path.

The files appear in this order:

1. `<agent-dir>/AGENTS.md`
2. `<agent-dir>/settings.json`
3. The native config file
4. Each `settingsFiles` entry, in array order
5. Each extension-registered file, in registration order

`<agent-dir>` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent`.

A `settingsFiles` entry resolves like this:

| Form          | Resolves from                       |
| ------------- | ----------------------------------- |
| `~/name.md`   | The home directory.                 |
| `/abs/path`   | Its own path.                       |
| `rel/name.md` | The native config file's directory. |

The catalog deduplicates by real path when a file exists, and by literal path otherwise. The first entry wins, so a later duplicate collapses into the earlier one.

Labels are the shortest trailing path suffix that keeps entries distinct. Two files with the same basename are told apart by one more path segment.

A missing file stays listed. A successful save creates it, including parent directories.

Saving writes the file atomically through a temporary file and a rename, and follows a symlink to its target. Only the native config is validated. Every other catalog file is written exactly as edited.

An `AGENTS.md` save invalidates folder discovery and broadcasts the change, because the saved prompt belongs to a folder row.

## Extension files

A Pimote extension adds catalog files with `context.settings.registerFile(path)`. A relative path resolves from the extension's own entry module, and a leading `~` expands to the home directory. See the SDK guide `packages/sdk/docs/authoring.md`.
