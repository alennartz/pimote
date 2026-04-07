# Pimote

A full-featured web client for [pi](https://github.com/mariozechner/pi-coding-agent). Use your coding agent from your phone, tablet, or any browser — with multi-session management, real-time streaming, and push notifications.

Pimote implements all of pi's RPC-compatible UI extension mechanisms (select, confirm, input, editor, status, widgets, panels), so you can use your favorite pi extensions exactly as they work in the terminal — just through a browser.

## Why

Using pi through SSH on a phone doesn't work well — you can't scroll while the agent is working, and taking over sessions between devices means hunting for PIDs. Pimote gives you a dedicated UI that solves these problems and enables multi-session management across projects.

## Architecture

```
Phone/Browser ←→ Pimote Server
                      ↕
                AgentSession (pi SDK)
```

Pimote is an npm workspace monorepo with four packages:

| Package              | Path               | Description                                           |
| -------------------- | ------------------ | ----------------------------------------------------- |
| **`@pimote/shared`** | `shared/`          | TypeScript types for the WebSocket wire protocol      |
| **`@pimote/server`** | `server/`          | Node.js HTTP + WebSocket server hosting pi sessions   |
| **client**           | `client/`          | SvelteKit PWA (Svelte 5, Tailwind CSS, shadcn-svelte) |
| **`@pimote/panels`** | `packages/panels/` | Library for extensions to push card data to the UI    |

### Server

Node.js process that embeds pi `AgentSession` instances directly via the SDK. Manages session lifecycles, brokers WebSocket connections, buffers events for reconnect replay, bridges extension UI calls, detects conflicting processes, and delivers push notifications.

### Client

Installable PWA (Svelte 5, Tailwind CSS, shadcn-svelte) with real-time streaming, multi-session tabs, folder browsing, extension UI, and push notifications. Works on phone and desktop.

## Usage

### Projects and Folders

The landing page shows a session-first home view. Sessions are grouped by project and ordered by recency so you can quickly resume work. Use the top-level **New session** action to pick any discovered project and start fresh.

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
- **Steer** the agent while it's working — messages queue and deliver when the agent is ready
- **Abort** a running agent turn
- **Switch models** and **thinking levels** on the fly
- **Compact** the conversation to manage context window usage (also supports auto-compaction)
- Use **slash commands** — type `/` to get autocomplete for skills, extension commands, and prompt templates
- **Listen** to responses via per-message text-to-speech

### Extensions

Pimote bridges all of pi's UI extension mechanisms over WebSocket:

- **Dialogs** — select (inline with keyboard shortcuts), confirm, text input, and multi-line code editor (CodeMirror with syntax highlighting)
- **Status bar** — live status entries from extensions
- **Panels** — structured card data pushed by extensions, displayed in a side panel (desktop) or overlay (mobile)

This means any pi extension that uses the standard UI APIs works in Pimote without modification.

### Multi-Device and Conflict Handling

- **Session takeover** — if a project has an external pi process running (e.g., from a terminal), Pimote detects it and offers to kill it and take over
- **Device switching** — if you open the same session from another browser/device, the new connection displaces the old one
- **Push notifications** — enable notifications to get alerted when a background session finishes working (useful when switching away from the browser)

### Reconnect

Network drops are handled transparently. The server buffers recent events per session, so when you reconnect, any missed events are replayed automatically — no lost output.

## Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- At least one LLM provider configured (pi is bundled as a dependency)

## Install

### From npm

```bash
npm install -g @pimote/pimote
```

Then start it:

```bash
pimote
```

On first run, Pimote launches a setup flow that:

- explains what Pimote does
- asks which parent directories to scan for projects
- asks which port to use
- writes `~/.config/pimote/config.json`
- starts the server for you

You can also run setup explicitly:

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

### With npx

```bash
npx @pimote/pimote
```

This uses the same first-run setup flow.

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

The first-run wizard creates this file for you, but you can also edit it manually. The most important setting is `roots`: parent directories that contain your projects. Pimote scans each root one level deep and discovers project folders by looking for `.git` or `package.json`.

Example:

```json
{
  "roots": ["/home/you/projects", "/home/you/work"],
  "port": 3000
}
```

With this config, if `/home/you/projects/` contains `my-app/` and `another-repo/`, both show up in Pimote's folder browser.

### Options

| Field                  | Type       | Default        | Description                                   |
| ---------------------- | ---------- | -------------- | --------------------------------------------- |
| `roots`                | `string[]` | **(required)** | Parent directories to scan for projects       |
| `port`                 | `number`   | `3000`         | Server port                                   |
| `idleTimeout`          | `number`   | `1800000`      | Idle session reap timeout (ms, default 30min) |
| `bufferSize`           | `number`   | `1000`         | Event ring buffer size per session            |
| `defaultProvider`      | `string`   | —              | Default LLM provider                          |
| `defaultModel`         | `string`   | —              | Default model                                 |
| `defaultThinkingLevel` | `string`   | —              | Default thinking level                        |

VAPID keys for push notifications are auto-generated on first run and written back to the config file. Session metadata and push subscription state live under `~/.local/state/pimote` (or `$XDG_STATE_HOME/pimote`).

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

## `@pimote/panels`

A standalone package that pi extensions can import to push structured card data into the Pimote side panel. Cards appear in a responsive side panel (desktop) or overlay (mobile).

```typescript
import { detect } from '@pimote/panels';

export function activate(ctx: ExtensionAPI) {
  const panel = detect(ctx);
  if (!panel) return; // not running in pimote

  panel.update([
    {
      id: 'status',
      title: 'Build Status',
      color: 'green',
      body: [{ style: 'compact', items: ['All tests passing'] }],
    },
  ]);
}
```

See [`packages/panels/README.md`](packages/panels/README.md) for full API docs.

## Status

Early development.

## License

MIT. See [LICENSE](LICENSE).
