# Pimote

A PWA + Node.js server for remote and local access to [pi](https://github.com/mariozechner/pi-coding-agent).

## Why

Using pi through SSH on a phone doesn't work well — you can't scroll while the agent is working, and taking over sessions between devices means hunting for PIDs. A dedicated UI solves these problems and enables multi-session management across projects.

## What

**Pimote Server** — A Node.js process that:

- Indexes project folders and pi sessions on your machine
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
- Browses folders and sessions across projects
- Sends prompts, steers, aborts, switches models
- Slash command autocomplete — typing `/` shows a fuzzy-filtered dropdown of available commands (skills, extension commands, prompt templates) with argument completion for extension commands
- Handles extension UI dialogs (select, confirm, input)
- Receives push notifications when background sessions finish working
- Reconnects transparently with gap replay and session displacement handling

## Architecture

```
Phone/Browser ←→ Cloudflare Tunnel ←→ Pimote Server
                                           ↕
                                     AgentSession (pi SDK)
                                     Event Buffer
                                     Folder Index
```

Internet access via Cloudflare tunnel. Auth via API key/token.

## Status

Early development (v1 implemented).
