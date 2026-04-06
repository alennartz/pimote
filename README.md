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

The server embeds pi `AgentSession` instances directly via the SDK and brokers WebSocket connections to clients. Key capabilities:

- Indexes project folders and discovers existing pi sessions
- Manages multiple concurrent sessions per client with status tracking
- Buffers coalesced events for seamless reconnect after network drops
- Detects conflicting external pi processes and remote sessions
- Bridges extension UI (dialogs, panels, status) over WebSocket
- Sends Web Push notifications (VAPID) when background sessions finish
- Handles session takeover by killing external processes or conflicting sessions

### Client

An installable PWA that works on phone and desktop:

- Multi-session tabs with fast switching and status indicators (working / idle / needs-attention)
- Real-time streaming conversation rendering with independent scrolling
- Folder and session browsing across projects
- Prompt, steer, abort, model/thinking-level switching
- Slash command autocomplete (skills, extension commands, prompt templates)
- Extension UI dialogs (select, confirm, input, editor with CodeMirror)
- Live panel cards from extensions (side panel on desktop, overlay on mobile)
- Push notifications for background session completion
- Transparent reconnect with gap replay
- Text-to-speech per message

## Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- At least one LLM provider configured (pi is bundled as a dependency)

## Setup

```bash
git clone https://github.com/alennartz/pimote.git
cd pimote
make install
make build
```

## Configuration

Pimote reads its config from `~/.config/pimote/config.json` (respects `$XDG_CONFIG_HOME`).

Create the file with at least a `roots` array pointing to your project directories:

```json
{
  "roots": ["/home/you/projects/my-app", "/home/you/projects/another-repo"]
}
```

### Options

| Field                  | Type       | Default        | Description                                   |
| ---------------------- | ---------- | -------------- | --------------------------------------------- |
| `roots`                | `string[]` | **(required)** | Project directories to index                  |
| `port`                 | `number`   | `3000`         | Server port                                   |
| `idleTimeout`          | `number`   | `1800000`      | Idle session reap timeout (ms, default 30min) |
| `bufferSize`           | `number`   | `1000`         | Event ring buffer size per session            |
| `defaultProvider`      | `string`   | —              | Default LLM provider                          |
| `defaultModel`         | `string`   | —              | Default model                                 |
| `defaultThinkingLevel` | `string`   | —              | Default thinking level                        |

VAPID keys for push notifications are auto-generated on first run and written back to the config file.

## Running

### Production

```bash
make build
make start
```

Override the port: `make start PORT=3001`

Then open `http://localhost:3000` (or your configured port).

> **Note:** Pimote has no built-in authentication. If you expose it over the internet, front it with a reverse proxy that handles auth (e.g., Cloudflare Tunnel with Access, OAuth2 Proxy, Tailscale).

### Development

Run in two separate terminals:

```bash
# Terminal 1 — server with hot-reload
make dev-server

# Terminal 2 — Vite dev server (proxies WebSocket to the server)
make dev-client
```

## Commands

```
make install        Install all workspace dependencies
make build          Build shared → server → client (production)
make start          Start production server
make dev-server     Server with hot-reload (tsx watch)
make dev-client     Vite dev server with HMR
make test           Run all tests (server + client)
make format         Format with Prettier
make lint           Run ESLint
make check          Type-check (svelte-check + tsc)
make clean          Remove all build artifacts
make help           Show all targets
```

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

Private — not yet open source.
