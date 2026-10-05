# Pimote

A PWA + Node.js server for remote and local access to [pi](https://github.com/mariozechner/pi-coding-agent).

## Why

Using pi through SSH on a phone doesn't work well — you can't scroll while the agent is working, and taking over sessions between devices means hunting for PIDs. A dedicated UI solves these problems and enables multi-session management across folders.

## What

**Pimote Server** — A Node.js process that:

- Discovers code and persona folders sparsely beneath configured scan roots, and curates them in a folder registry
- Creates new code folders on demand (`mkdir` + `git init`) within configured roots
- Embeds AgentSession instances directly via the pi SDK
- Manages multiple concurrent sessions per client with status tracking
- Brokers WebSocket connections between clients and sessions
- Buffers coalesced events for seamless reconnect after network drops
- Detects conflicting external pi processes and remote pimote sessions per folder
- Tracks per-client session ownership with reconnect displacement
- Sends push notifications (Web Push / VAPID) when background sessions finish working
- Handles session takeover by killing external processes or conflicting remote sessions

**Pimote Client** — A Svelte 5 PWA that:

- Works on phone (installable) and desktop browser
- Manages multiple concurrent sessions with fast switching (ActiveSessionBar)
- Tracks session status (working / idle / needs-attention)
- Streams conversations in real time with independent scrolling
- Browses folders and their sessions from a dashboard, with a per-connection manager agent that can list folders, repos, and open sessions
- Creates new folders from the dashboard (choose root, name, `mkdir` + `git init`)
- Sends prompts, runs native shell commands with `!`/`!!`, steers, aborts, and switches models
- Slash command autocomplete — typing `/` shows a fuzzy-filtered dropdown of available commands (skills, extension commands, prompt templates) with argument completion for extension commands
- Handles extension UI dialogs (select, confirm, input)
- Displays live panel cards pushed by extensions (subagent progress, custom dashboards) in a responsive side panel (desktop) or overlay (mobile)
- Receives push notifications when background sessions finish working
- Persists client identity and active sessions in localStorage — reopening the app restores session tabs and reconnects automatically
- Reconnects transparently with gap replay and session displacement handling
- Optionally upgrades a session into a voice call (PWA-only in v1) — the server bridges to a speechmux sidecar and the pi session runs under a voice-interpreter extension that mediates between spoken user turns and a `my-pi` worker subagent
- Single-tab per browser (multi-tab not supported — shared localStorage would cause conflicts)

**`@pimote/sdk`** — The workspace extensibility package (`packages/sdk/`) that pi extensions import to talk to pimote. Panels card-push (`@pimote/sdk/panels`) provides `detect()` for pimote detection and `PanelHandle` for updating/clearing cards via the pi EventBus; the folder discovery/creation seam types (`@pimote/sdk/folders`) let user modules register folder sources and creators. Cards flow through the server (throttled) to the client panel.

## Architecture

```
Phone/Browser ←→ Cloudflare Tunnel ←→ Pimote Server
                                           ↕
                                     AgentSession (pi SDK)
                                     EventBus (panel cards)
                                     Event Buffer
                                     Folder Model
```

Internet access via Cloudflare tunnel. Auth via API key/token.

## Status

Early development (v1 implemented).
