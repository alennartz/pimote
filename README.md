# Pimote

[![npm](https://img.shields.io/npm/v/%40pimote%2Fpimote?style=flat-square)](https://www.npmjs.com/package/@pimote/pimote)
[![license](https://img.shields.io/npm/l/%40pimote%2Fpimote?style=flat-square)](LICENSE)
[![node](https://img.shields.io/node/v/%40pimote%2Fpimote?style=flat-square)](https://www.npmjs.com/package/@pimote/pimote)
[![publish app](https://github.com/alennartz/pimote/actions/workflows/publish-pimote.yml/badge.svg)](https://github.com/alennartz/pimote/actions/workflows/publish-pimote.yml)
[![sdk](https://img.shields.io/npm/v/%40pimote%2Fsdk?style=flat-square&label=%40pimote%2Fsdk)](https://www.npmjs.com/package/@pimote/sdk)

A full-featured web client for [Pi](https://github.com/earendil-works/pi). Use your coding agent from your phone, tablet, or any browser — with multi-session management, real-time streaming, and push notifications.

Pimote implements all of pi's RPC-compatible UI extension mechanisms (select, confirm, input, editor, status, widgets, panels), so you can use your favorite pi extensions exactly as they work in the terminal — just through a browser.

**Links:** [npm package](https://www.npmjs.com/package/@pimote/pimote) · [SDK package](https://www.npmjs.com/package/@pimote/sdk) · [issues](https://github.com/alennartz/pimote/issues) · [Pi source](https://github.com/earendil-works/pi) · [Pi docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)

## Quick start

**Requirements:** Node.js 22+, npm 10+, and at least one working pi provider/model configuration.

### Install globally

```bash
npm install -g @pimote/pimote
pimote
```

### Or run once with npx

```bash
npx @pimote/pimote
```

On first run, Pimote will:

- explain what it does
- ask which parent directories to scan for folders
- ask which port to use
- write the native config to `$XDG_CONFIG_HOME/pimote/config.json` (default: `~/.config/pimote/config.json`)
- start the server for you

Then open the printed URL in your browser — usually `http://localhost:3000` unless you picked another port.

> The npm package name is `@pimote/pimote`, but the installed command is simply `pimote`.

## Why

Using pi through SSH on a phone doesn't work well — you can't scroll while the agent is working, and taking over sessions between devices means hunting for PIDs. Pimote gives you a dedicated UI that solves these problems and enables multi-session management across projects.

## Architecture

```
Phone/Browser ←→ Pimote Server
                      ↕
                AgentSession (pi SDK)
```

Pimote is published as the app package `@pimote/pimote` at the repo root, backed by an npm workspace monorepo:

| Package              | Path            | Description                                                                 |
| -------------------- | --------------- | --------------------------------------------------------------------------- |
| **`@pimote/pimote`** | `./`            | Publishable app package and `pimote` CLI                                    |
| **`@pimote/server`** | `server/`       | Node.js HTTP + WebSocket server hosting pi sessions                         |
| **client**           | `client/`       | SvelteKit PWA (Svelte 5, Tailwind CSS, shadcn-svelte)                       |
| **`@pimote/sdk`**    | `packages/sdk/` | Extensibility SDK: Pi session bridges plus the global Pimote extension host |

The `shared/` directory holds TypeScript types for the WebSocket wire protocol shared between server and client — it's a tsc-only project, not a published package. The voice-mode pi extension lives at `server/src/voice/` and is loaded into each session only when voice is configured (see [Voice mode](#voice-mode)). The static-host pi extension lives at `server/src/static-host/` and is loaded unconditionally — it exposes the `pimote_static_host` / `pimote_static_host_remove` agent tools that publish a local folder under `/s/<slug>/` and push a tappable card to the panel UI. The file-download extension is also loaded into every session; it lets the agent offer any file readable by the server as a one-time, user-approved browser download. The home dashboard Settings button opens Appearance and User tabs plus a server-resolved file editor for Pi files, native Pimote config, configured files, and Pimote extension registrations. The existing file-edit seam supplies file content, and native Pimote config writes are validated before they apply.

A separate **native Android client** lives at `mobile/android/` — a voice-first Kotlin app that places calls through the system telephony stack (`SelfManagedConnectionService`), and exposes your projects as Android system contacts so they're callable by name from Google Assistant / Gemini ("Hey Google, call <project>") and from the dialer's name search. It also ships an **Android Auto** surface (`CarAppService`, currently dev-mode / sideloaded) with a project list that places a new-session call on tap and a recency list that resumes a past session. Independent Gradle project, Docker-based build (`make android-test` / `make android-build`), not part of the npm workspace; it maintains a hand-written mirror of the WebSocket protocol. The Android mirror needs updates for both the windowed `list_folders` contract and the session observer/archive contract. See `mobile/android/README.md`.

### Server

Node.js process that embeds pi `AgentSession` instances directly via the SDK. Manages session lifecycles, discovers your folders (sparse scan of the configured roots) and curates them, brokers WebSocket connections, buffers events for reconnect replay, bridges extension UI calls, detects conflicting processes, hosts the persisted manager persona, and delivers push notifications.

### Client

Installable PWA (Svelte 5, Tailwind CSS, shadcn-svelte) with real-time streaming, multi-session tabs, a folder dashboard with a manager composer and persisted session list, extension UI, push notifications, and a session StatusBar that surfaces model/thinking controls plus live context-window and session-cost indicators. Assistant responses also show their own cost breakdowns. The Appearance tab previews paired interface, editor, and terminal themes before saving a choice across devices with the same Pimote username. Works on phone and desktop.

## Pi documentation

Pimote embeds Pi's coding-agent SDK. For Pi-specific configuration, agent instructions, skills, extensions, and tools, see the [Pi documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs) or [Pi source repository](https://github.com/earendil-works/pi). This README covers Pimote-specific setup, configuration, folder behavior, and UI workflows.

## Usage

### Dashboard, Folders, and the Manager

The Dashboard shows discovered folders beside the manager composer and persisted session list. On mobile, the folder list fills the screen and the manager opens as a sheet. The list loads in windows as you scroll. Search matches folder names, paths, tags, persona names, session names, and first messages.

Folders come from configured scan roots and sources registered by global Pimote extensions. A folder is **code** (git-initialized, with plain `AGENTS.md` or none) or a **persona** (its `AGENTS.md` has persona marker front matter). Rows show code, code-hub, persona, or persona-hub based on nature and the hub fact. You can favorite and archive folders.

A **hub** combines existing folders into one working folder. Symlinks are the default layout. Detached worktrees place code members in nested detached Git checkouts; persona members always remain symlinks. The member identity stays the canonical source path, while `worktreePath` identifies the nested checkout. Code hubs can contain hub-level code. Persona hubs have their own prompt and memory.

Use **New session** to start in any discovered folder, or create a folder from the dialog. Choose code, persona, code-hub, or persona-hub, then follow the wizard. Code folders receive `AGENTS.md`; persona folders receive persona-marker `AGENTS.md` and `memory.md`. Hubs include a managed member block. Each creation flow opens a session in the new folder. Folder rows also let you manage hub members, archive or restore folders, and edit folder-scoped `AGENTS.md` files.

Worktree members must be clean before removal. The dashboard and manager can disband marked worktree hubs only. Pimote closes idle, observerless sessions first, then checks activity, generated hub content, checkout cleanliness, and detached-`HEAD` reachability. It never merges or deletes branches.

The manager is a persona folder at `managerRoot`. Its persisted sessions use a nine-tool Pimote surface for folder and session management. The surface includes dashboard folder mutations, guarded worktree-hub disband, unified session search, and explicit resume by ID. Shipped folder docs describe the folder model, topology recipes, and tool behavior. Every session lists those docs in its system prompt.

### Sessions

Each conversation with pi is a **session**, tied to a project folder. You can:

- **Open multiple sessions** simultaneously across different projects — tabs in the active session bar let you switch instantly
- **Resume existing sessions** — the session list shows all past conversations with creation date, message count, and a preview of the first message
- **Rename sessions** for easier identification
- **Archive sessions** to hide them from the default list without deleting them (toggle "show archived" to see them again); archiving closes the live session for all observers, and unarchiving does not reopen it
- **Resume an archived session** through the manager by its session ID; the operation reopens the original record and never creates a replacement
- **Delete sessions** permanently
- **Redo from a message** to move the active branch within the same session; abandoned continuations remain available in the branch explorer
- **Fork from a message** to continue from that point in a new session file while the original session stays untouched and live; the forked prompt text returns to the composer (Replace, Append, Prepend, or Ignore on draft conflict)
- **Start fresh** with a new session in the same project at any time

When my-pi's subagents extension runs, inspect its root-relative hierarchy in the side panel and open a child as an interactive view of the existing runtime. Child views stay outside root session tabs, archives, and folder counts.

Unarchived session state persists across browser restarts — reopening Pimote restores your open tabs and reconnects automatically. Archived sessions leave the restore set; the dashboard unarchives them, then opens them explicitly, while the manager can resume the original record by session ID.

### Conversation

Once in a session, you can:

- **Send prompts** with text and pasted/attached images
- **Run shell commands directly** with a leading `!` (for example, `!git status`); use `!!` to show the result without adding it to the agent's context. Commands stream output in their own conversation item and can be cancelled independently of an agent turn.
- **Steer** the agent while it's working — messages queue and deliver when the agent is ready
- **Abort** a running agent turn
- **Switch models** and **thinking levels** on the fly
- See **session context usage** and Pi's complete-session cost breakdown in the StatusBar or session details
- See each **assistant response's cost breakdown**, including matching tool-result usage, in the transcript
- Costs use Pi's configured model prices, not provider invoice totals
- **Compact** the conversation to manage context window usage (also supports auto-compaction)
- Use **slash commands** — type `/` to get autocomplete for skills, extension commands, and prompt templates
- **Reference files with `@`** — type `@` to get TUI-style path autocomplete (backed by `fd`); the literal `@path` is sent through to the agent, which reads the file with its own tools (no server-side inlining)
- **Log in to model providers** with `/login` — an interactive dialog adds OAuth subscription providers (Claude Pro/Max, ChatGPT, GitHub Copilot) remotely, without SSHing into the server or hand-editing `auth.json` (API-key and custom providers are still configured manually)
- Open the **branch explorer** with `/tree` to browse branches, expand collapsed message runs, search visible messages or all conversation text, edit labels, and resume from a selected message
- Use **Redo from here** for one-click navigation without compaction, or open **Redo with compaction…** to use pi's default summarizer or enter custom instructions
- **Listen** to responses via per-message text-to-speech
- **Download files** when the agent offers one — approve the native browser download from the toast or the session's Downloads inbox

### Extensions

Pimote bridges all of pi's UI extension mechanisms over WebSocket:

- **Dialogs** — select (inline with keyboard shortcuts), confirm, text input, and multi-line code editor (CodeMirror with syntax highlighting)
- **Status bar** — live status entries from extensions
- **Panels** — structured card data pushed by extensions, displayed in a side panel (desktop) or overlay (mobile); cards may declare an `href` to render as a tappable link

This means any pi extension that uses the standard UI APIs works in Pimote without modification. Separately, a server-level `file_get` / `file_put` protocol pair supports reading and atomically writing files for the global Settings and folder-scoped editors; these commands are not tied to a session. Saves use last-write-wins for ordinary files (there is no conflict detection). Native Pimote config writes are validated before the atomic write.

Pimote registers Pi's `codemode`, `tool_search`, and MCP extensions in every session. Their activation follows Pi's settings and MCP configuration: `defaultTools` controls `codemode` and `tool_search`, while MCP servers come from `~/.pi/agent/mcp.json` or a project's `.pi/mcp.json`. MCP tool exposure follows Pi's `codemode`, `deferred`, `direct`, and `hidden` modes. Each Pimote session owns its MCP connections, including any stdio server processes. See the [Pi MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), [tool settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#tools), and [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) documentation for configuration and behavior.

Pimote also ships in-server pi extensions. The static-host extension gives the agent two tools, `pimote_static_host` and `pimote_static_host_remove`, for publishing a local folder of static files (built PWA, report, demo, etc.) at `/s/<slug>/` on the same origin as the Pimote UI. Each new registration emits a tappable panel card pointing at the bundle. A request for an already-active folder reuses its existing slug and URL instead of creating another copy. Bundle registrations are persisted per session under `~/.local/state/pimote/static-host/` and garbage-collected on server boot.

The file-download extension gives the agent `pimote_send_file({ path })` and `pimote_cancel_file_send({ id })`. Sending a file registers the existing file for a single native download; Pimote never copies or deletes the source. The browser asks for an explicit click in the in-app toast or the session-local Downloads inbox, and the one-shot link is consumed even if the file later disappears. Offers are session-scoped and are not exposed to the Android client.

### Multi-Device and Conflict Handling

- **Shared sessions** — multiple clients can observe one live session, receive the same events, and send commands
- **Voice calls** — one client holds the call for a session; a forced call transfer ends the call for the old holder without closing the session
- **External process conflict** — if a project has an external pi process running (e.g., from a terminal), Pimote detects it and offers to kill it and continue
- **Push notifications** — enable notifications to get alerted when a background session finishes working (useful when switching away from the browser); a file offer opens that session's Downloads inbox rather than downloading automatically

### Reconnect

Network drops are handled transparently. The server buffers recent events per session, so when you reconnect, any missed events are replayed automatically. Accepted shell commands continue on the server and are reconciled on reconnect; a context-excluded `!!` result may be omitted by the existing context-only resync.

## Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- At least one LLM provider configured (Pimote bundles its pinned pi runtime)
- **`fd`** (fd-find) — optional, enables `@` file-path autocomplete in the composer. If absent, autocomplete returns no suggestions and Pimote shows a one-time warning toast; everything else works normally.

## Install

### From npm

```bash
npm install -g @pimote/pimote
pimote
```

### With npx

```bash
npx @pimote/pimote
```

The first-run setup flow is the same either way. You can also run setup explicitly:

```bash
pimote init
```

Use a custom port either during setup or at startup:

```bash
pimote init --port 3001
pimote --port 3001
```

You can preseed project roots too:

```bash
pimote init --root ~/projects --root ~/work --port 3001
```

After startup, open the printed URL in your browser.

### From source

```bash
git clone https://github.com/alennartz/pimote.git
cd pimote
npm install
npm run build
npm start
```

## Configuration

Pimote reads its native config from the effective XDG path (`$XDG_CONFIG_HOME/pimote/config.json`, or `~/.config/pimote/config.json`). The home dashboard Settings button opens Appearance and User tabs plus a server-provided manifest of effective Pi instructions, Pi settings, native Pimote config, configured files, and Pimote extension files. Paths and labels come from the server. Missing files remain visible and can be created by saving them. Each opening holds one manifest snapshot; config-list changes appear on the next opening. See [Themes](docs/shipped/themes.md) for theme selection and theme-file details.

The first-run wizard creates this file for you, but you can also edit it manually. The most important setting is `roots`: parent directories that contain your folders. Pimote sparsely scans each root with no depth bound: folders with a `.git` marker are **code**, folders whose `AGENTS.md` opens with persona marker front matter are **personas**, and everything else is skipped structure that discovery descends through (pruning `node_modules`, `dist`, `build`, `target`, `.venv`) — nested entries below skipped wrappers surface at any depth, while an included folder stops descent. A top-level symlink of an included folder that points outside it is a **shortcut**: discovery follows it and lists whatever code/persona folders it reaches.

Global Pimote extensions live in `$XDG_CONFIG_HOME/pimote/extensions/`. The host loads direct JavaScript/TypeScript modules and extension directories in deterministic order. A default `PimoteExtension` factory can call `registerSource()`, `registerFile()`, `themes.registerFile()`, and `on('shutdown', ...)`. Relative settings and theme paths resolve from the module. User-scoped Pi packages are adapted only through their `pimote.extensions` manifest entries. Project packages and `pi.extensions` entries never run in the global Pimote host. A module listed in both sections is an explicit dual-host module with separate lifecycles. Folder creation remains a Pimote core operation; external creator registration is not an SDK surface.

Example extension:

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

const extension: PimoteExtension = (context) => {
  context.folders.registerSource({ id: 'example', list: async () => [] });
  context.settings.registerFile('./instructions.md');
  context.on('shutdown', async () => {});
};

export default extension;
```

Example:

```json
{
  "roots": ["/home/you/projects", "/home/you/work"],
  "managerRoot": "/home/you/.local/state/pimote/manager",
  "port": 3000
}
```

With this config, if `/home/you/projects/` contains `my-app/` and `another-repo/`, both show up in the dashboard's folder list.

### Native config reference

See [Settings and configuration](docs/shipped/settings.md) for the native
config fields, defaults, validation rules, and reload timing.

#### Voice mode

Voice mode is optional. When the `voice` section is absent from the config
(or its URLs are unset), the feature stays fully dormant: no voice extension
is loaded into sessions, no orchestrator is wired up, and the server behaves
exactly as it would without voice support.

To enable it, point pimote at an externally managed speechmux instance
(systemd, container, remote host — pimote does not spawn the sidecar):

```json
{
  "roots": ["/home/you/projects"],
  "defaultInterpreterModel": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "defaultWorkerModel": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "voice": {
    "speechmuxSignalUrl": "wss://speechmux.example.com/signal",
    "speechmuxLlmWsUrl": "ws://127.0.0.1:6789"
  }
}
```

Both `voice.speechmuxSignalUrl` and `voice.speechmuxLlmWsUrl` are required to
enable voice. `defaultInterpreterModel` and `defaultWorkerModel` accept either a
provider/model slug string such as `anthropic/claude-sonnet-4-5` or an object
with `provider` and `modelId` fields. The slug form carries an optional
thinking-level suffix, `provider/model:level` — for example
`genetec/gpt-6-luna:low` — with levels `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`; the interpreter applies it after the model switch.
Both refs are optional. Unset, the interpreter keeps the session's default
model, and spawned workers inherit it.

When `updateCheck` is enabled (the default), the server checks npm for a newer `@pimote/pimote` release using a six-hour cache. Connected clients receive an update notification with the release link; dismissing it leaves a persistent ambient marker so the notice can be revisited. Set `"updateCheck": false` to disable registry checks and update indicators.

VAPID keys for push notifications are auto-generated on first run and written back to the config file. Session metadata, push subscriptions, and folder curation (favorites, archive state, and tags) live under `~/.local/state/pimote` (or `$XDG_STATE_HOME/pimote`). Hub membership comes from on-disk symlinks and Git-verified nested worktrees; the curation store keeps no hub list.

## Running

### Installed app

```bash
pimote
```

Other useful commands:

```bash
pimote start
pimote --port 3001
pimote help
pimote version
```

> **Note:** Pimote has no built-in authentication. If you expose it over the internet, front it with a reverse proxy that handles auth (e.g., Cloudflare Tunnel with Access, OAuth2 Proxy, Tailscale).

### Local installed deployment

Deployment targets are local. Copy the generic template, set local values, then run the targets:

```bash
cp Makefile.local.example Makefile.local
make deploy
```

This will:

- build the app
- pack the npm package
- install it under the configured release root
- update the configured `current` symlink
- write or update the configured user systemd unit
- reload and restart the configured user service

Useful follow-up commands:

```bash
make status
make logs
make start-installed
make deploy-paths
```

### Development

Run in two separate terminals:

```bash
# Terminal 1 — server with hot-reload
make dev-server

# Terminal 2 — Vite dev server (proxies WebSocket to the server)
make dev-client
```

## Commands

### CLI

```bash
pimote                         Start Pimote (runs setup if needed)
pimote start                   Start with existing config
pimote init                    Create or update config
pimote --port 3001             Override the port for this run
pimote init --root ~/projects  Seed one or more project roots
pimote help                    Show CLI help
pimote version                 Show installed version
```

### Source repo

```
npm install         Install workspace dependencies
npm run build       Build shared → server → client
npm start           Start the repo build via the publishable CLI
make package        Create a publishable npm tarball in .artifacts/
make dev-server     Server with hot-reload (tsx watch)
make dev-client     Vite dev server with HMR
make test           Run all tests (server + client)
make format         Format with Prettier
make lint           Run ESLint
make check          Type-check (svelte-check + tsc)
make clean          Remove all build artifacts
make help           Show make targets

Copy `Makefile.local.example` to `Makefile.local` for local deployment targets.
```

For first-publish steps, see the release skill at `.pi/skills/pimote-release/SKILL.md`.

## `@pimote/sdk`

Pimote's SDK exposes APIs for Pi session extensions and process-global Pimote extensions. The `panels` module pushes structured card data into the Pimote side panel; cards appear in a responsive side panel (desktop) or overlay (mobile). The `subagents` module defines the typed provider seam that my-pi uses to publish subagent hierarchies and lend existing child sessions to interactive views. See the SDK guide for host scopes and the `@pimote/sdk/pimote` factory API.

```ts
import { detect } from '@pimote/sdk';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  const panels = detect(pi, 'my-extension');
  if (!panels) return; // not running in pimote

  panels.updateCards([
    {
      id: 'status',
      color: 'success',
      header: { title: 'Build', tag: 'passed' },
      body: [{ content: 'All 42 tests passed', style: 'text' }],
      footer: ['2.3s'],
    },
  ]);
};

export default extension;
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for full API docs.

## Status

Early development.

## License

MIT. See [LICENSE](LICENSE).
