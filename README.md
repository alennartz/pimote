# Pimote

[![npm](https://img.shields.io/npm/v/%40pimote%2Fpimote?style=flat-square)](https://www.npmjs.com/package/@pimote/pimote)
[![license](https://img.shields.io/npm/l/%40pimote%2Fpimote?style=flat-square)](LICENSE)
[![node](https://img.shields.io/node/v/%40pimote%2Fpimote?style=flat-square)](https://www.npmjs.com/package/@pimote/pimote)
[![publish app](https://github.com/alennartz/pimote/actions/workflows/publish-pimote.yml/badge.svg)](https://github.com/alennartz/pimote/actions/workflows/publish-pimote.yml)
[![sdk](https://img.shields.io/npm/v/%40pimote%2Fsdk?style=flat-square&label=%40pimote%2Fsdk)](https://www.npmjs.com/package/@pimote/sdk)

A full-featured web client for [pi](https://github.com/mariozechner/pi-coding-agent). Use your coding agent from your phone, tablet, or any browser — with multi-session management, real-time streaming, and push notifications.

Pimote implements all of pi's RPC-compatible UI extension mechanisms (select, confirm, input, editor, status, widgets, panels), so you can use your favorite pi extensions exactly as they work in the terminal — just through a browser.

**Links:** [npm package](https://www.npmjs.com/package/@pimote/pimote) · [SDK package](https://www.npmjs.com/package/@pimote/sdk) · [issues](https://github.com/alennartz/pimote/issues) · [pi](https://github.com/mariozechner/pi-coding-agent)

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
- write `~/.config/pimote/config.json`
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

| Package              | Path            | Description                                                  |
| -------------------- | --------------- | ------------------------------------------------------------ |
| **`@pimote/pimote`** | `./`            | Publishable app package and `pimote` CLI                     |
| **`@pimote/server`** | `server/`       | Node.js HTTP + WebSocket server hosting pi sessions          |
| **client**           | `client/`       | SvelteKit PWA (Svelte 5, Tailwind CSS, shadcn-svelte)        |
| **`@pimote/sdk`**    | `packages/sdk/` | Extensibility SDK: panels + folder sources for pi extensions |

The `shared/` directory holds TypeScript types for the WebSocket wire protocol shared between server and client — it's a tsc-only project, not a published package. The voice-mode pi extension lives at `server/src/voice/` and is loaded into each session only when voice is configured (see [Voice mode](#voice-mode)). The static-host pi extension lives at `server/src/static-host/` and is loaded unconditionally — it exposes the `pimote_static_host` / `pimote_static_host_remove` agent tools that publish a local folder under `/s/<slug>/` and push a tappable card to the panel UI. The file-download extension is also loaded into every session; it lets the agent offer any file readable by the server as a one-time, user-approved browser download. The Dashboard also includes an **Agent instructions** editor for the user-level `~/.pi/agent/AGENTS.md`, with optional tag-wrap snippets configured by `tagSnippets` in `~/.config/pimote/config.json` (the snippet lookup does not currently honor a custom `$XDG_CONFIG_HOME`).

A separate **native Android client** lives at `mobile/android/` — a voice-first Kotlin app that places calls through the system telephony stack (`SelfManagedConnectionService`), and exposes your projects as Android system contacts so they're callable by name from Google Assistant / Gemini ("Hey Google, call <project>") and from the dialer's name search. It also ships an **Android Auto** surface (`CarAppService`, currently dev-mode / sideloaded) with a project list that places a new-session call on tap and a recency list that resumes a past session. Independent Gradle project, Docker-based build (`make android-test` / `make android-build`), not part of the npm workspace; speaks the same WebSocket protocol as the PWA. Its folder-listing mirror predates the windowed `list_folders` contract and needs an Android-side update. See `mobile/android/README.md`.

### Server

Node.js process that embeds pi `AgentSession` instances directly via the SDK. Manages session lifecycles, discovers your folders (sparse scan of the configured roots) and curates them, brokers WebSocket connections, buffers events for reconnect replay, bridges extension UI calls, detects conflicting processes, hosts a per-connection manager agent, and delivers push notifications.

### Client

Installable PWA (Svelte 5, Tailwind CSS, shadcn-svelte) with real-time streaming, multi-session tabs, a folder dashboard with a manager chat, extension UI, push notifications, and a session StatusBar that surfaces model/thinking controls plus live context-window and lifetime-cost indicators. Works on phone and desktop.

## Usage

### Dashboard, Folders, and the Manager

The landing page is the Dashboard: a folders column beside a **manager chat** on desktop; on mobile the folders list is fullscreen and the manager opens as a sheet. The list covers every discovered folder (expandable to its sessions) and loads in windows as you scroll. Its search box runs on the server against the whole list: it matches folder names, paths, tags, and persona names, plus session names and first messages. Folders come from a sparse scan of your configured roots plus any custom folder sources: a folder is **code** (git-initialized, plain `AGENTS.md` or none) or a **persona** (its `AGENTS.md` carries persona marker front matter), and each row renders one of four icons — code, code-hub, persona, persona-hub — depending on its nature and whether shortcut symlinks hang off it. You can favorite and archive folders, and combine existing repos into a **hub** — a folder with symlinks to each member, its own `git init` + `.gitignore`, and a generated `AGENTS.md` — which can be disbanded again later. Use the **New session** action to pick any discovered folder and start fresh, or **create a new folder** directly from the dialog — choose a root, name the folder, and Pimote creates the directory, runs `git init`, and opens a session in it. The manager is a per-connection pi session with a pinned pimote toolset (`pimote_list_folders`, `pimote_folder_tree`, repos, and open sessions), so you can ask things like "which of my repos are dirty?"

### Sessions

Each conversation with pi is a **session**, tied to a project folder. You can:

- **Open multiple sessions** simultaneously across different projects — tabs in the active session bar let you switch instantly
- **Resume existing sessions** — the session list shows all past conversations with creation date, message count, and a preview of the first message
- **Rename sessions** for easier identification
- **Archive sessions** to hide them from the default list without deleting them (toggle "show archived" to see them again)
- **Delete sessions** permanently
- **Fork sessions** to branch a conversation from a specific point
- **Start fresh** with a new session in the same project at any time

Session state persists across browser restarts — reopening Pimote restores your open tabs and reconnects automatically.

### Conversation

Once in a session, you can:

- **Send prompts** with text and pasted/attached images
- **Run shell commands directly** with a leading `!` (for example, `!git status`); use `!!` to show the result without adding it to the agent's context. Commands stream output in their own conversation item and can be cancelled independently of an agent turn.
- **Steer** the agent while it's working — messages queue and deliver when the agent is ready
- **Abort** a running agent turn
- **Switch models** and **thinking levels** on the fly
- See **session context usage** and **lifetime cost** at a glance in the StatusBar
- **Compact** the conversation to manage context window usage (also supports auto-compaction)
- Use **slash commands** — type `/` to get autocomplete for skills, extension commands, and prompt templates
- **Reference files with `@`** — type `@` to get TUI-style path autocomplete (backed by `fd`); the literal `@path` is sent through to the agent, which reads the file with its own tools (no server-side inlining)
- **Log in to model providers** with `/login` — an interactive dialog adds OAuth subscription providers (Claude Pro/Max, ChatGPT, GitHub Copilot) remotely, without SSHing into the server or hand-editing `auth.json` (API-key and custom providers are still configured manually)
- Open **Tree Navigation** with `/tree` to browse session history, search/filter nodes, and edit labels (right-click on desktop, long-press on touch)
- Pick a tree navigation mode: no summary, summarize, or a custom summary prompt (with in-dialog loading while summarization runs)
- **Listen** to responses via per-message text-to-speech
- **Download files** when the agent offers one — approve the native browser download from the toast or the session's Downloads inbox

### Extensions

Pimote bridges all of pi's UI extension mechanisms over WebSocket:

- **Dialogs** — select (inline with keyboard shortcuts), confirm, text input, and multi-line code editor (CodeMirror with syntax highlighting)
- **Status bar** — live status entries from extensions
- **Panels** — structured card data pushed by extensions, displayed in a side panel (desktop) or overlay (mobile); cards may declare an `href` to render as a tappable link

This means any pi extension that uses the standard UI APIs works in Pimote without modification. Separately, a server-level `file_get` / `file_put` protocol pair supports reading and atomically writing files for the Agent instructions editor; these commands are not tied to a session. Saves use last-write-wins (there is no conflict detection).

Pimote also ships in-server pi extensions. The static-host extension gives the agent two tools, `pimote_static_host` and `pimote_static_host_remove`, for publishing a local folder of static files (built PWA, report, demo, etc.) at `/s/<slug>/` on the same origin as the Pimote UI. Each registration emits a tappable panel card pointing at the bundle. Bundle registrations are persisted per session under `~/.local/state/pimote/static-host/` and garbage-collected on server boot.

The file-download extension gives the agent `pimote_send_file({ path })` and `pimote_cancel_file_send({ id })`. Sending a file registers the existing file for a single native download; Pimote never copies or deletes the source. The browser asks for an explicit click in the in-app toast or the session-local Downloads inbox, and the one-shot link is consumed even if the file later disappears. Offers are session-scoped and are not exposed to the Android client.

### Multi-Device and Conflict Handling

- **Session takeover** — if a project has an external pi process running (e.g., from a terminal), Pimote detects it and offers to kill it and take over
- **Device switching** — if you open the same session from another browser/device, the new connection displaces the old one
- **Push notifications** — enable notifications to get alerted when a background session finishes working (useful when switching away from the browser); a file offer opens that session's Downloads inbox rather than downloading automatically

### Reconnect

Network drops are handled transparently. The server buffers recent events per session, so when you reconnect, any missed events are replayed automatically. Accepted shell commands continue on the server and are reconciled on reconnect; a context-excluded `!!` result may be omitted by the existing context-only resync.

## Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- At least one LLM provider configured (pi is bundled as a dependency)
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

Pimote reads its config from `~/.config/pimote/config.json` (respects `$XDG_CONFIG_HOME`).

The first-run wizard creates this file for you, but you can also edit it manually. The most important setting is `roots`: parent directories that contain your folders. Pimote sparsely scans each root with no depth bound: folders with a `.git` marker are **code**, folders whose `AGENTS.md` opens with persona marker front matter are **personas**, and everything else is skipped structure that discovery descends through (pruning `node_modules`, `dist`, `build`, `target`, `.venv`) — nested entries below skipped wrappers surface at any depth, while an included folder stops descent. A top-level symlink of an included folder that points outside it is a **shortcut**: discovery follows it and lists whatever code/persona folders it reaches. Additional repos and hub folders can be contributed by folder sources — TypeScript modules in `folderSourcesDir` (default `~/.config/pimote/folder-sources/`). A source exports a `sources` array; each source `list()`s entries (`{ kind: 'repo', ... }` or `{ kind: 'hub', path, name, memberPaths }`) — paths need not exist on disk yet, and missing ones are shown with a warning chip. An optional awaited `onFolderOpen(path)` hook runs before any open of a listed entry (row click, new session, manager tool) — for custom provisioning. A missing hub entry is materialized automatically first (folder + member symlinks + AGENTS.md, built by pimote itself); missing repo entries are the extension's job inside `onFolderOpen`. A thrown error aborts the open. A `creators` array provides explicit creation flows (built in: mkdir + git init).

Example:

```json
{
  "roots": ["/home/you/projects", "/home/you/work"],
  "managerRoot": "/home/you/.local/state/pimote/manager",
  "port": 3000
}
```

With this config, if `/home/you/projects/` contains `my-app/` and `another-repo/`, both show up in the dashboard's folder list.

### Options

| Field                     | Type                  | Default                           | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roots`                   | `string[]`            | **(required)**                    | Parent directories to scan for folders                                                                                                                                                                                                                                                                                                                                                       |
| `managerRoot`             | `string`              | `~/.local/state/pimote/manager`   | The manager persona's working directory; a leading `~`/`~/` expands to the home directory. Must not be or contain the home directory: the seeded manager persona `AGENTS.md` would otherwise load as ancestor context for every pi session below it. Inside a scan root it is legal — its entry is excluded from folder listings and trees, so it renders only as the pinned manager surface |
| `folderSourcesDir`        | `string`              | `~/.config/pimote/folder-sources` | Directory scanned for user folder-source modules (pluggable discovery; reads the deprecated legacy `projectSourcesDir` key and falls back to the legacy `~/.config/pimote/project-sources` directory — both will be retired)                                                                                                                                                                 |
| `port`                    | `number`              | `3000`                            | Server port                                                                                                                                                                                                                                                                                                                                                                                  |
| `appName`                 | `string`              | `Pimote`                          | Display name: browser tab title, iOS app title, and installed PWA name                                                                                                                                                                                                                                                                                                                       |
| `idleTimeout`             | `number`              | `1800000`                         | Idle session reap timeout (ms, default 30min)                                                                                                                                                                                                                                                                                                                                                |
| `bufferSize`              | `number`              | `1000`                            | Event ring buffer size per session                                                                                                                                                                                                                                                                                                                                                           |
| `defaultProvider`         | `string`              | —                                 | Default LLM provider                                                                                                                                                                                                                                                                                                                                                                         |
| `defaultModel`            | `string`              | —                                 | Default model                                                                                                                                                                                                                                                                                                                                                                                |
| `defaultThinkingLevel`    | `string`              | —                                 | Default thinking level                                                                                                                                                                                                                                                                                                                                                                       |
| `defaultInterpreterModel` | `{provider, modelId}` | —                                 | Voice interpreter model (falls back to `defaultProvider`/`defaultModel`)                                                                                                                                                                                                                                                                                                                     |
| `defaultWorkerModel`      | `{provider, modelId}` | —                                 | Voice worker model passed to `my-pi` subagent spawns                                                                                                                                                                                                                                                                                                                                         |
| `voice`                   | `object`              | —                                 | Voice subsystem config (see below)                                                                                                                                                                                                                                                                                                                                                           |
| `tagSnippets`             | `string[]`            | —                                 | Optional tag names shown as one-tap wrap snippets in the Agent instructions editor                                                                                                                                                                                                                                                                                                           |
| `updateCheck`             | `boolean`             | `true`                            | Check npm for newer Pimote releases and notify connected clients                                                                                                                                                                                                                                                                                                                             |

`appName` is applied at serve time — the server rewrites the PWA manifest and
HTML shell on the way out, so a change takes effect on the next page reload.
Note that browsers capture the app name at install time: an already-installed
PWA keeps its old name on the home screen until it is reinstalled.

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
enable voice. `defaultInterpreterModel` and `defaultWorkerModel` fall back to
`defaultProvider` + `defaultModel` if unset.

When `updateCheck` is enabled (the default), the server checks npm for a newer `@pimote/pimote` release using a six-hour cache. Connected clients receive an update notification with the release link; dismissing it leaves a persistent ambient marker so the notice can be revisited. Set `"updateCheck": false` to disable registry checks and update indicators.

VAPID keys for push notifications are auto-generated on first run and written back to the config file. Session metadata, push subscriptions, and the folder registry (favorites, archive, hubs) live under `~/.local/state/pimote` (or `$XDG_STATE_HOME/pimote`).

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

If you want your personal Pimote service to run from an installed package instead of this repo's live build output, use the deployment targets:

```bash
make deploy
```

This will:

- build the app
- pack the npm package
- install it under `~/.local/share/pimote/releases/...`
- update `~/.local/share/pimote/current`
- write/update `~/.config/systemd/user/pimote.service`
- reload and restart the user service

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
make install-local  Install the built package under ~/.local/share/pimote
make install-service Write/update the user systemd unit
make deploy         Install local release + restart service
make start-installed Run the currently installed package manually
make dev-server     Server with hot-reload (tsx watch)
make dev-client     Vite dev server with HMR
make test           Run all tests (server + client)
make format         Format with Prettier
make lint           Run ESLint
make check          Type-check (svelte-check + tsc)
make clean          Remove all build artifacts
make help           Show make targets
```

For first-publish steps, see [docs/releasing.md](docs/releasing.md).

## `@pimote/sdk`

Pimote's extensibility SDK — the package pi extensions import to talk to pimote. The `panels` module pushes structured card data into the Pimote side panel; cards appear in a responsive side panel (desktop) or overlay (mobile).

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
