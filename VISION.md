# Pimote

A PWA + Node.js server for remote and local access to [pi](https://github.com/mariozechner/pi-coding-agent).

## Why

Using pi through SSH on a phone doesn't work well — you can't scroll while the agent is working, and taking over sessions between devices means hunting for PIDs. A dedicated UI solves these problems and opens the door to multi-session management across projects.

## What

**Pimote Server** — A Node.js process manager that:
- Indexes project folders and pi sessions on your machine
- Spawns and manages `pi --mode rpc` instances on demand
- Brokers WebSocket connections between clients and pi
- Buffers events for seamless reconnect after network drops
- Handles session takeover by killing existing pi processes per folder

**Pimote Client** — A Svelte 5 PWA that:
- Works on phone (installable) and desktop browser
- Streams conversations in real time with independent scrolling
- Browses folders and sessions across projects
- Sends prompts, steers, aborts, switches models
- Handles extension UI dialogs (select, confirm, input)
- Reconnects transparently with gap replay

## Architecture

```
Phone/Browser ←→ Cloudflare Tunnel ←→ Pimote Server ←→ pi --mode rpc
                                           ↕
                                     Process Manager
                                     Event Buffer
                                     Session Index
```

Internet access via Cloudflare tunnel. Auth via API key/token.

## Status

Early development. See [docs/brainstorms/pimote.md](docs/brainstorms/pimote.md) for the full brainstorm including decisions, trade-offs, and open questions.
