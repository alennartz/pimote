# Pimote — Comprehensive Manual Test Plan

**Version:** 1.0
**Date:** 2026-03-28
**System Under Test:** Pimote (PWA client + Node.js server for remote pi coding-agent access)
**Author:** QA

---

## Table of Contents

1. [Test Environment & Prerequisites](#1-test-environment--prerequisites)
2. [TP-01: Server Startup & Configuration](#tp-01-server-startup--configuration)
3. [TP-02: HTTP Server & Static File Serving](#tp-02-http-server--static-file-serving)
4. [TP-03: WebSocket Connection Lifecycle](#tp-03-websocket-connection-lifecycle)
5. [TP-04: Folder & Session Index Browsing](#tp-04-folder--session-index-browsing)
6. [TP-05: Session Lifecycle (Open / Close / Reap)](#tp-05-session-lifecycle-open--close--reap)
7. [TP-06: Conversation — Prompt, Steer, Follow-Up, Abort](#tp-06-conversation--prompt-steer-follow-up-abort)
8. [TP-07: Real-Time Streaming & Message Rendering](#tp-07-real-time-streaming--message-rendering)
9. [TP-08: Tool Call Visualization](#tp-08-tool-call-visualization)
10. [TP-09: Model & Thinking Level Controls](#tp-09-model--thinking-level-controls)
11. [TP-10: Multi-Session Management](#tp-10-multi-session-management)
12. [TP-11: Reconnect & Event Replay](#tp-11-reconnect--event-replay)
13. [TP-12: Session Conflict Detection & Takeover](#tp-12-session-conflict-detection--takeover)
14. [TP-13: Extension UI Bridging](#tp-13-extension-ui-bridging)
15. [TP-14: Push Notifications (VAPID / Web Push)](#tp-14-push-notifications-vapid--web-push)
16. [TP-15: PWA Installation & Service Worker](#tp-15-pwa-installation--service-worker)
17. [TP-16: Responsive Layout & Mobile UX](#tp-16-responsive-layout--mobile-ux)
18. [TP-17: Auto-Compaction & Auto-Retry Events](#tp-17-auto-compaction--auto-retry-events)
19. [TP-18: Error Handling & Edge Cases](#tp-18-error-handling--edge-cases)
20. [TP-19: Security](#tp-19-security)
21. [TP-20: Performance & Stability](#tp-20-performance--stability)

---

## 1. Test Environment & Prerequisites

### Required Setup
| Item | Details |
|------|---------|
| **Server Machine** | Linux with `/proc` filesystem (for process takeover tests) |
| **Node.js** | v20+ |
| **Config File** | `~/.config/pimote/config.json` with valid `roots` array |
| **pi SDK** | `@mariozechner/pi-coding-agent` installed, API keys configured |
| **Test Projects** | At least 2 project directories under configured roots, each with `.git` or `package.json` |
| **Browsers** | Chrome (latest), Firefox (latest), Safari (latest, for PWA tests) |
| **Mobile Device** | Android phone with Chrome, or iOS with Safari (for push + PWA tests) |
| **Network Tool** | Browser DevTools (Network tab), `wscat` or similar for raw WS testing |

### Config File Template
```json
{
  "roots": ["/home/user/projects"],
  "port": 3000,
  "idleTimeout": 1800000,
  "bufferSize": 1000
}
```

### Notation
- **[P]** = Precondition
- **[S]** = Step
- **[E]** = Expected Result
- **Severity:** 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low

---

## TP-01: Server Startup & Configuration

### TC-01.01 — Normal startup with valid config 🔴
- **[P]** `~/.config/pimote/config.json` exists with `"roots": ["/valid/path"]`
- **[S]** Run `node server/src/index.ts` (or compiled equivalent)
- **[E]** Server outputs:
  - `[pimote] Server listening on http://localhost:3000`
  - `[pimote] WebSocket endpoint: ws://localhost:3000/ws`
  - Lists all configured roots
- **[E]** Process stays running; no errors in console

### TC-01.02 — Missing config file 🔴
- **[P]** `~/.config/pimote/config.json` does not exist
- **[S]** Start server
- **[E]** Server exits with a clear error: `Config file not found at <path>` and includes example config

### TC-01.03 — Invalid JSON in config 🟠
- **[P]** Config file contains `{ invalid json`
- **[S]** Start server
- **[E]** Server exits with: `Failed to parse <path> as JSON`

### TC-01.04 — Missing `roots` field 🟠
- **[P]** Config contains `{ "port": 3000 }` (no roots)
- **[S]** Start server
- **[E]** Server exits with: `Config "roots" must be a non-empty array of strings`

### TC-01.05 — Empty `roots` array 🟠
- **[P]** Config contains `{ "roots": [] }`
- **[S]** Start server
- **[E]** Server exits with roots validation error

### TC-01.06 — Defaults applied for optional fields 🟡
- **[P]** Config contains only `{ "roots": ["/valid"] }`
- **[S]** Start server
- **[E]** Server starts on port 3000 (default); idle timeout is 30 min; buffer size is 1000

### TC-01.07 — PORT env var overrides config 🟡
- **[P]** Config has `"port": 3000`
- **[S]** Run `PORT=4000 node server/src/index.ts`
- **[E]** Server listens on port 4000

### TC-01.08 — VAPID key auto-generation 🟠
- **[P]** Config has no `vapidPublicKey`/`vapidPrivateKey` fields
- **[S]** Start server
- **[E]** Server generates VAPID keys, writes them back to config file, starts successfully
- **[E]** Config file now contains `vapidPublicKey` and `vapidPrivateKey` fields
- **[E]** Existing config fields are preserved (not overwritten)

### TC-01.09 — VAPID keys reused on restart 🟡
- **[P]** Config already contains VAPID keys from previous run
- **[S]** Restart server
- **[E]** Same VAPID keys used; config file not modified

### TC-01.10 — Graceful shutdown 🟠
- **[P]** Server is running with active sessions
- **[S]** Send SIGINT (Ctrl+C) or SIGTERM
- **[E]** Console shows `[pimote] Shutting down...`
- **[E]** All sessions are closed/disposed; server exits cleanly with code 0

---

## TP-02: HTTP Server & Static File Serving

### TC-02.01 — Health check endpoint 🟡
- **[S]** `GET /health`
- **[E]** 200, body: `{"status":"ok"}`

### TC-02.02 — VAPID key endpoint 🟡
- **[S]** `GET /api/vapid-key`
- **[E]** 200, body: `{"publicKey":"<base64-string>"}` (non-empty after VAPID generation)

### TC-02.03 — Root serves index.html 🔴
- **[S]** `GET /` in browser
- **[E]** Client PWA loads; `Content-Type: text/html`

### TC-02.04 — Static assets served correctly 🟠
- **[S]** Navigate to app; check Network tab
- **[E]** JS files: `application/javascript`, CSS files: `text/css`, PNG icons: `image/png`, WOFF2 fonts: `font/woff2`

### TC-02.05 — SPA fallback for unknown routes 🟠
- **[S]** `GET /some/random/path` in browser
- **[E]** Returns `index.html` (200, `text/html`) — SPA client handles routing

### TC-02.06 — Directory traversal prevention 🔴
- **[S]** `GET /../../../etc/passwd`
- **[E]** Does NOT serve the file; returns either SPA fallback or 404

### TC-02.07 — Non-GET methods on unknown routes 🟡
- **[S]** `POST /anything`
- **[E]** 404, body: `{"error":"not found"}`

### TC-02.08 — WebSocket upgrade on /ws 🔴
- **[S]** Open WebSocket connection to `ws://localhost:3000/ws`
- **[E]** Connection established; server logs `WebSocket client connected`

### TC-02.09 — WebSocket upgrade rejected on non-/ws path 🟡
- **[S]** Attempt WebSocket upgrade on `/other`
- **[E]** Connection destroyed; no upgrade

### TC-02.10 — manifest.json accessible 🟡
- **[S]** `GET /manifest.json`
- **[E]** Returns PWA manifest with `application/json` content type

---

## TP-03: WebSocket Connection Lifecycle

### TC-03.01 — Initial connection and status indicator 🔴
- **[P]** Server is running
- **[S]** Open client in browser
- **[E]** Sidebar shows green connection status dot
- **[E]** `connection.status` transitions: `disconnected` → `connecting` → `connected`

### TC-03.02 — Intentional disconnect 🟡
- **[S]** Close browser tab
- **[E]** Server logs `WebSocket client disconnected`
- **[E]** `handler.cleanup()` runs: pending UI responses resolved with `undefined`, subscribed sessions detached

### TC-03.03 — Auto-reconnect on server restart 🔴
- **[P]** Client connected with an open session
- **[S]** Kill and restart server process
- **[E]** Client status indicator turns yellow/red, then green after reconnect
- **[E]** Client automatically reconnects (exponential backoff: 1s → 2s → 4s → ... → max 30s)
- **[E]** All subscribed sessions are re-sent via `reconnect` commands

### TC-03.04 — Auto-reconnect on network drop 🔴
- **[P]** Client connected
- **[S]** Simulate network interruption (e.g., toggle airplane mode on phone, or use browser DevTools throttling → Offline)
- **[S]** Restore network
- **[E]** Status transitions: `connected` → `reconnecting` → `connected`
- **[E]** Reconnect delay resets to 1s after successful reconnection

### TC-03.05 — Pending requests rejected on close 🟡
- **[P]** Client sends a command while WS is open
- **[S]** Disconnect network immediately after send
- **[E]** Pending promise rejects with `WebSocket closed` error

### TC-03.06 — Send while disconnected 🟡
- **[P]** WebSocket is not open
- **[S]** Attempt `connection.send(...)` from console
- **[E]** Immediately rejects with `WebSocket not connected`

### TC-03.07 — Reconnect backoff cap 🟡
- **[P]** Server is unreachable
- **[S]** Observe reconnect attempts
- **[E]** Delay doubles each attempt: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s... (caps at 30s)

---

## TP-04: Folder & Session Index Browsing

### TC-04.01 — Folder list loads on connection 🔴
- **[P]** Roots contain projects with `.git`, `package.json`, or `.pi/sessions`
- **[S]** Open client; observe sidebar / landing page
- **[E]** Folder list populates with project names from all configured roots
- **[E]** Each folder shows its `name` (directory basename)

### TC-04.02 — Empty root directory 🟡
- **[P]** One root exists but contains no project directories
- **[S]** Load folder list
- **[E]** That root contributes no folders; no error

### TC-04.03 — Inaccessible root directory 🟡
- **[P]** One root path does not exist or has no read permission
- **[S]** Load folder list
- **[E]** Server logs warning; other roots still scanned; no crash

### TC-04.04 — Non-project directories filtered out 🟡
- **[P]** Root contains subdirectories without `.git`, `package.json`, or `.pi/sessions`
- **[S]** Load folder list
- **[E]** Those subdirectories do not appear

### TC-04.05 — Folder active status enrichment 🟠
- **[P]** Open a session for project A (currently working), project B (idle), no session for project C
- **[S]** Reload folder list
- **[E]** Project A: `activeStatus: 'working'`, `activeSessionCount: 1`
- **[E]** Project B: `activeStatus: 'idle'`, `activeSessionCount: 1`
- **[E]** Project C: `activeStatus: null`, `activeSessionCount: 0`

### TC-04.06 — Folder attention status 🟠
- **[P]** Session B has `needsAttention = true` (agent finished while not viewed)
- **[S]** Reload folder list
- **[E]** Project B shows `activeStatus: 'attention'` (unless another session there is `working`, which takes precedence)

### TC-04.07 — Session list for a folder 🔴
- **[P]** Project folder has 3+ pi sessions
- **[S]** Click/expand folder in sidebar
- **[E]** Lists sessions with: id, name (if set), created date, modified date, message count, first message preview
- **[E]** Sessions sorted by modified date (most recent first, or per SDK ordering)

### TC-04.08 — Session list for folder with no sessions 🟡
- **[P]** Project exists but has no `.pi/sessions`
- **[S]** Click/expand folder
- **[E]** Empty session list; no error

### TC-04.09 — Click session to open 🔴
- **[P]** Session list visible
- **[S]** Click a session item
- **[E]** Session opens (see TP-05); view switches to conversation view

### TC-04.10 — Open new session (no existing session selected) 🔴
- **[P]** Folder expanded
- **[S]** Click folder name (or "new session" action)
- **[E]** New session created for that folder; conversation view shows empty state

---

## TP-05: Session Lifecycle (Open / Close / Reap)

### TC-05.01 — Open new session 🔴
- **[S]** Click a folder to open a new session
- **[E]** Server creates AgentSession via pi SDK
- **[E]** `session_opened` event received with `sessionId` and `folder` info
- **[E]** Client adds session to registry, subscribes, switches view
- **[E]** `get_state` and `get_messages` fetched atomically
- **[E]** StatusBar shows model name and thinking level

### TC-05.02 — Open existing session from file 🟠
- **[S]** Click a specific session from the session list
- **[E]** Session loaded from file; existing conversation history appears in MessageList
- **[E]** Message count matches expectations

### TC-05.03 — Close session 🔴
- **[S]** Click close button in StatusBar
- **[E]** `close_session` command sent; `session_closed` event received
- **[E]** Session removed from registry and subscription set
- **[E]** View returns to landing page (unless other sessions exist)
- **[E]** Pending extension UI responses for that session are resolved with `undefined`

### TC-05.04 — Idle session reaping 🟠
- **[P]** Open a session, then disconnect the client
- **[S]** Wait for `idleTimeout` (default 30 min; use shorter timeout for testing, e.g., 30s)
- **[E]** Server closes the session automatically
- **[E]** Session no longer appears in `getAllSessions()`

### TC-05.05 — Active session not reaped 🟡
- **[P]** Client connected to a session, periodically interacting
- **[S]** Observe over time
- **[E]** Session NOT reaped (has a connected client)

### TC-05.06 — Working session not reaped even without client 🟡
- **[P]** Session is currently streaming (status: working), client disconnects
- **[S]** Wait beyond idle timeout
- **[E]** Session still alive (but `lastActivity` should be checked — verify behavior based on implementation: currently checks `connectedClient === null && Date.now() - lastActivity > idleTimeout`)

### TC-05.07 — Multiple sessions on same folder 🟠
- **[S]** Open two separate sessions for the same project folder
- **[E]** Both sessions co-exist independently with separate `sessionId` values
- **[E]** Folder's `activeSessionCount` reflects both

---

## TP-06: Conversation — Prompt, Steer, Follow-Up, Abort

### TC-06.01 — Send a prompt 🔴
- **[P]** Session is idle (no streaming)
- **[S]** Type a message in InputBar and press Enter (or click Send)
- **[E]** `prompt` command sent with `message` and `sessionId`
- **[E]** User message appears in message list
- **[E]** Agent begins working (status: working, streaming starts)
- **[E]** Response streams in real-time

### TC-06.02 — Prompt with Shift+Enter for newline 🟡
- **[S]** Type text, press Shift+Enter, type more text, press Enter
- **[E]** Shift+Enter inserts newline; Enter sends the multi-line message

### TC-06.03 — Steer while agent is working 🟠
- **[P]** Agent is streaming (status: working)
- **[S]** Type a steering message in InputBar and send
- **[E]** `steer` command sent; InputBar mode is "steer" during streaming
- **[E]** Agent adjusts behavior based on steering message

### TC-06.04 — Send prompt after agent finishes (follow-up pattern) 🟠
- **[P]** Agent has finished (status: idle), conversation has messages
- **[S]** Type a follow-up message in InputBar and send
- **[E]** `prompt` command sent (InputBar uses `prompt` for all non-streaming sends)
- **[E]** Agent resumes working on the follow-up

> **Note:** The `follow_up` command exists in the protocol but is not used by the current InputBar UI. The UI always sends `prompt` when not streaming and `steer` when streaming.

### TC-06.05 — Abort while streaming 🔴
- **[P]** Agent is actively streaming
- **[S]** Click the Abort button
- **[E]** `abort` command sent; agent stops promptly
- **[E]** `agent_end` event received; status returns to idle
- **[E]** Partial response visible in conversation

### TC-06.06 — InputBar mode transitions 🟠
Verify InputBar shows the correct mode:
| Condition | Placeholder Text | Send Button | Abort Button |
|-----------|-----------------|-------------|--------------|
| No session open | "Open a session to start…" | Disabled | Hidden |
| Idle (not streaming) | "Send a message…" | Send icon (primary color) | Hidden |
| Working (streaming) | "Steer the conversation…" | Steer icon (streaming color) | Visible (red) |

The InputBar sends `prompt` when idle and `steer` when streaming. There is no separate `follow_up` mode in the UI.

### TC-06.07 — Empty prompt prevented 🟡
- **[S]** Click Send with empty input
- **[E]** Nothing sent; no error

### TC-06.08 — Long prompt text 🟡
- **[S]** Paste a 10,000+ character prompt and send
- **[E]** Sent successfully; no truncation or crash

---

## TP-07: Real-Time Streaming & Message Rendering

### TC-07.01 — Text streaming display 🔴
- **[P]** Agent is responding
- **[S]** Observe MessageList
- **[E]** Text appears incrementally as `message_update` events arrive
- **[E]** `streamingText` accumulates; displayed at the end of the message list

### TC-07.02 — Thinking block streaming 🟠
- **[P]** Thinking level is set to a non-"off" value; agent responds
- **[S]** Observe conversation
- **[E]** Thinking text appears in a collapsible ThinkingBlock (labeled "Thinking...")
- **[E]** Thinking content accumulates in `streamingThinking`

### TC-07.03 — Message finalized on message_end 🔴
- **[P]** Agent finishes a message
- **[S]** Observe when `message_end` arrives
- **[E]** `streamingText` and `streamingThinking` cleared
- **[E]** Complete message added to `messages` array
- **[E]** Rendered with full markdown formatting

### TC-07.04 — Markdown rendering 🟠
- **[S]** Send a prompt that elicits a response with: headings, bold, italics, code blocks, bullet lists, links
- **[E]** All markdown elements rendered correctly
- **[E]** Code blocks have syntax highlighting with correct language detection

### TC-07.05 — Auto-scroll on new content 🟠
- **[P]** Conversation is long enough to scroll
- **[S]** Observe while agent is streaming
- **[E]** Message list auto-scrolls to bottom as new content arrives

### TC-07.06 — Auto-scroll respects manual scroll position 🟡
- **[P]** Agent is streaming
- **[S]** Manually scroll up to read earlier messages
- **[E]** Auto-scroll pauses; user stays at their scroll position
- **[S]** Scroll back to bottom
- **[E]** Auto-scroll resumes

### TC-07.07 — User messages rendered 🟡
- **[S]** Send a prompt
- **[E]** User message appears with correct role styling (distinct from assistant)

### TC-07.08 — Streaming indicator 🟡
- **[P]** Agent is streaming
- **[E]** StreamingIndicator (animated dots) visible at the bottom of conversation

### TC-07.09 — Multiple messages in conversation 🟡
- **[S]** Have a multi-turn conversation (3+ prompts)
- **[E]** All user and assistant messages rendered in correct order

---

## TP-08: Tool Call Visualization

### TC-08.01 — Tool call start 🟠
- **[P]** Agent invokes a tool (e.g., `bash`, `read`, `edit`)
- **[E]** `tool_execution_start` event renders a ToolCall component
- **[E]** Shows: tool name, input args (collapsible JSON)

### TC-08.02 — Tool call streaming output 🟠
- **[P]** Tool execution in progress
- **[E]** `tool_execution_update` events stream partial output into `partialResult`
- **[E]** ToolCall component shows output incrementally

### TC-08.03 — Tool call completion 🟠
- **[P]** Tool finishes execution
- **[E]** `tool_execution_end` event received; tool call removed from `activeToolCalls`
- **[E]** Final result appears in the next `message_end`

### TC-08.04 — Multiple concurrent tool calls 🟡
- **[P]** Agent executes multiple tools in parallel
- **[E]** Each tool call tracked independently by `toolCallId`
- **[E]** All displayed simultaneously with their own progress

### TC-08.05 — Tool call args and result collapsibility 🟡
- **[S]** Click on tool call args section
- **[E]** Toggles expanded/collapsed view of JSON arguments
- **[S]** Same for result section

---

## TP-09: Model & Thinking Level Controls

### TC-09.01 — Model picker shows available models 🟠
- **[S]** Click ModelPicker dropdown in StatusBar
- **[E]** Lists all models from `get_available_models`
- **[E]** Current model is highlighted/checked

### TC-09.02 — Switch model 🟠
- **[S]** Select a different model from the picker
- **[E]** `set_model` command sent with correct `provider` and `modelId`
- **[E]** StatusBar updates to show new model name

### TC-09.03 — Switch to non-existent model 🟡
- **[S]** (Via raw WS) Send `set_model` with invalid provider/modelId
- **[E]** Response: `success: false`, error: `Model not found: ...`

### TC-09.04 — Thinking level picker 🟠
- **[S]** Click ThinkingPicker dropdown (brain icon in StatusBar)
- **[E]** Shows 5 thinking levels: Off, Minimal, Low, Medium, High
- **[E]** Current level is highlighted with radio selection

### TC-09.05 — Set thinking level 🟠
- **[S]** Select a different thinking level from the radio group
- **[E]** `set_thinking_level` command sent automatically (reactive binding — no submit button)
- **[E]** StatusBar label updates to new level
- **[E]** Subsequent responses include/exclude thinking blocks accordingly

### TC-09.05a — Thinking level syncs on session switch 🟡
- **[P]** Two sessions with different thinking levels
- **[S]** Switch between sessions via ActiveSessionBar
- **[E]** ThinkingPicker reflects the correct level for each session (no stale value)

### TC-09.06 — Cycle model 🟡
- **[S]** (Via raw WS) Send `cycle_model`
- **[E]** Response includes new model info; model cycles to next available

### TC-09.07 — Cycle thinking level 🟡
- **[S]** (Via raw WS) Send `cycle_thinking_level`
- **[E]** Response includes new level; level cycles through available options

---

## TP-10: Multi-Session Management

### TC-10.01 — Open multiple sessions 🔴
- **[S]** Open sessions for 3 different projects
- **[E]** All 3 appear in ActiveSessionBar as pills
- **[E]** `subscribedSessions` set contains all 3 session IDs

### TC-10.02 — ActiveSessionBar pill display 🟠
- **[E]** Each pill shows project/folder name
- **[E]** Viewed session is visually highlighted (different style)

### TC-10.03 — Status dots on pills 🟠
| Session State | Expected Dot |
|---------------|-------------|
| Working | Green with ping animation |
| Needs Attention | Orange |
| Idle | Gray |

### TC-10.04 — Switch session via pill click 🔴
- **[S]** Click a different session's pill in ActiveSessionBar
- **[E]** `view_session` command sent to server
- **[E]** View switches to that session's conversation
- **[E]** `needsAttention` cleared for the switched-to session

### TC-10.05 — View session updates server-side tracking 🟠
- **[S]** Switch to session B via pill
- **[E]** Server's `viewedSessionId` updates to session B
- **[E]** When session B's agent finishes, it does NOT trigger `needsAttention` or push notification (because it's viewed)

### TC-10.06 — Background session finishes → needsAttention 🔴
- **[P]** Viewing session A; session B is working in background
- **[S]** Session B's agent finishes (`agent_end`)
- **[E]** Session B's `needsAttention` set to `true`
- **[E]** Session B's pill shows orange attention dot

### TC-10.07 — Close one of multiple sessions 🟠
- **[S]** Close session A while sessions B and C are open
- **[E]** Session A removed from ActiveSessionBar
- **[E]** View switches to another session (or landing if none)
- **[E]** Sessions B and C remain active

### TC-10.08 — Per-session state isolation 🔴
- **[S]** Open 2 sessions; send different prompts to each
- **[E]** Each session has its own: messages, streamingText, model, thinkingLevel, status, activeToolCalls
- **[E]** Switching between them shows the correct conversation for each

### TC-10.09 — Events routed to correct session 🔴
- **[P]** Two sessions open; both agents working simultaneously
- **[E]** `message_update` events with different `sessionId` values route to correct per-session state
- **[E]** No cross-contamination of streaming text between sessions

---

## TP-11: Reconnect & Event Replay

### TC-11.01 — Reconnect with incremental replay 🔴
- **[P]** Session open with ongoing conversation; events buffered
- **[S]** Disconnect client briefly (kill WS, toggle network); reconnect
- **[E]** Client sends `reconnect` with `sessionId` and `lastCursor`
- **[E]** Server responds with `buffered_events` containing missed events
- **[E]** Followed by `connection_restored` event
- **[E]** Conversation state is seamlessly restored (no duplicate or missing messages)

### TC-11.02 — Reconnect with cursor up to date 🟡
- **[P]** Client cursor equals server cursor (nothing missed)
- **[S]** Reconnect
- **[E]** `buffered_events` returned with empty array; `connection_restored` sent

### TC-11.03 — Reconnect with cursor too old → full resync 🟠
- **[P]** Client was disconnected long enough that its cursor is older than the oldest buffered event
- **[S]** Reconnect
- **[E]** Server returns `full_resync` with complete `SessionState` and all `messages`
- **[E]** Client rebuilds conversation from scratch — no missing data

### TC-11.04 — Event buffer coalescing 🟠
- **[P]** Agent sends many `message_update` deltas while client is connected
- **[S]** Disconnect, then reconnect
- **[E]** Replay does NOT include individual `message_update` deltas (they are coalesced)
- **[E]** `message_start` and `message_end` events ARE included
- **[E]** Conversation state is still correct after replay

### TC-11.05 — Tool execution update coalescing 🟡
- **[P]** Tool produces many `tool_execution_update` chunks
- **[S]** Disconnect and reconnect
- **[E]** Tool execution updates are coalesced; `tool_execution_start` and `tool_execution_end` are replayed

### TC-11.06 — Multi-session reconnect 🟠
- **[P]** 3 sessions open with different cursors
- **[S]** Disconnect and reconnect
- **[E]** Client sends 3 `reconnect` commands (one per subscribed session)
- **[E]** Each session gets its own `buffered_events` or `full_resync`

### TC-11.07 — Session expired during disconnect 🟡
- **[P]** Session was reaped by idle check while client was disconnected
- **[S]** Client reconnects, sends `reconnect` for the expired session
- **[E]** Server responds `success: false, error: "session_expired"`
- **[E]** Client handles gracefully (session removed from UI)

### TC-11.08 — Reconnect re-binds live events 🟠
- **[P]** Client reconnects to a session where the agent is still working
- **[S]** After reconnect
- **[E]** New live events stream correctly to the reconnected client
- **[E]** `sendLive` and `onStatusChange` callbacks updated to use the new WsHandler

---

## TP-12: Session Conflict Detection & Takeover

### TC-12.01 — Conflict detected on session open 🟠
- **[P]** An external `pi` process is running in the target folder (started via terminal)
- **[S]** Open a session for that folder
- **[E]** `session_conflict` event received with list of `{ pid, command }` entries
- **[E]** Conflict banner appears: "External pi processes detected in this project."
- **[E]** Two buttons: "Kill & Continue", "Dismiss"

### TC-12.02 — Conflict detected on reconnect 🟡
- **[P]** Session exists; external pi process started while client was disconnected
- **[S]** Reconnect
- **[E]** `session_conflict` event sent after reconnect

### TC-12.03 — Kill conflicting processes 🟠
- **[S]** Click "Kill & Continue" on conflict banner
- **[E]** `kill_conflicting_processes` command sent with `sessionId` and `pids`
- **[E]** Server sends SIGTERM, waits 1s, then SIGKILL if needed
- **[E]** Response confirms kill count
- **[E]** Banner dismissed; conflict state cleared

### TC-12.04 — Dismiss conflict 🟡
- **[S]** Click "Dismiss" on conflict banner
- **[E]** `conflictingProcesses` cleared locally; banner disappears
- **[E]** No kill command sent; external process still running

### TC-12.05 — Takeover folder command 🟠
- **[P]** External pi process running in a folder
- **[S]** Send `takeover_folder` command (via raw WS or UI if exposed)
- **[E]** External processes killed; new session opened for folder
- **[E]** Response includes `sessionId` and `killedProcesses` count

### TC-12.06 — No conflicts when none exist 🟡
- **[P]** No external pi processes in target folder
- **[S]** Open session
- **[E]** No `session_conflict` event sent

### TC-12.07 — Excludes own PID from conflict scan 🟡
- **[P]** Pimote server itself is a Node.js process in the scanned folder
- **[S]** Open session
- **[E]** Server's own PID not included in conflicts

---

## TP-13: Extension UI Bridging

### TC-13.01 — Select dialog 🟠
- **[P]** A pi extension triggers `ui.select(title, options)` during session
- **[E]** Client receives `extension_ui_request` with `method: 'select'`, `title`, `options` array
- **[E]** ExtensionDialog renders a modal with title and selectable option buttons (each showing `option.label`)
- **[S]** Click one option
- **[E]** `extension_ui_response` sent with `value: <option.value>`
- **[E]** Dialog closes; pi extension receives the selection

> **Note:** The ExtensionDialog expects options as `{label, value}` objects. The extension bridge sends the raw string array from `ui.select()`. Verify the client handles both formats or that they're consistently mapped.

### TC-13.02 — Confirm dialog 🟠
- **[P]** Extension triggers `ui.confirm(title, message)`
- **[E]** Dialog shows title, message, Yes/No buttons
- **[S]** Click "Yes"
- **[E]** Response sent with `confirmed: true`
- **[S]** (Repeat with "No")
- **[E]** Response sent with `confirmed: false`

### TC-13.03 — Input dialog 🟠
- **[P]** Extension triggers `ui.input(title, placeholder)`
- **[E]** Dialog shows title and text input with placeholder
- **[S]** Type text and submit
- **[E]** Response sent with `value: <typed text>`

### TC-13.04 — Cancel extension dialog 🟡
- **[S]** Close the extension dialog without selecting/confirming
- **[E]** Response sent with `cancelled: true`
- **[E]** Extension receives `undefined`

### TC-13.05 — Dialog with timeout 🟡
- **[P]** Extension dialog has a timeout option
- **[S]** Do not respond within timeout
- **[E]** Dialog auto-resolves with fallback value (undefined for select/input, false for confirm)

### TC-13.06 — Fire-and-forget: setStatus 🟡
- **[P]** Extension calls `ui.setStatus(key, text)`
- **[E]** `extension_ui_request` with `method: 'setStatus'` sent
- **[E]** ExtensionStatus component displays the status text

### TC-13.07 — Fire-and-forget: notify 🟡
- **[P]** Extension calls `ui.notify(message, type)`
- **[E]** Notification displayed in client UI

### TC-13.08 — Extension UI scoped to session 🟠
- **[P]** Two sessions open; extension dialog triggers in session A
- **[E]** Dialog only appears when viewing session A
- **[E]** Response correctly routed to session A's pending promise

### TC-13.09 — Extension UI responses cleared on session close 🟡
- **[P]** Extension dialog open; user closes the session
- **[E]** All pending UI responses for that session resolved with `undefined`

### TC-13.10 — Extension UI responses cleared on disconnect 🟡
- **[P]** Extension dialog pending; client disconnects
- **[E]** All pending UI responses resolved with `undefined` during `cleanup()`

---

## TP-14: Push Notifications (VAPID / Web Push)

### TC-14.01 — Notification banner appears 🟡
- **[P]** First time opening the app; `localStorage` has no `pimote-push-dismissed` key; `Notification.permission === 'default'`
- **[S]** Open a session (banner triggers after first session opens)
- **[E]** NotificationBanner appears: "Enable notifications to know when sessions finish." with Enable and X (dismiss) buttons

### TC-14.01a — Notification banner does not appear when already granted 🟡
- **[P]** `Notification.permission === 'granted'`
- **[S]** Open app, open a session
- **[E]** Banner does NOT appear (permission already granted)

### TC-14.01b — Notification banner dismiss persists across reloads 🟡
- **[S]** Click the X (dismiss) button on the banner
- **[E]** `localStorage` item `pimote-push-dismissed` set to `"true"`
- **[S]** Reload the page; open a new session
- **[E]** Banner does NOT appear again

### TC-14.02 — Enable push notifications 🔴
- **[S]** Click "Enable Notifications" on the banner
- **[E]** Browser prompts for notification permission
- **[S]** Grant permission
- **[E]** Client fetches VAPID public key from `/api/vapid-key`
- **[E]** Service worker subscribes to push via `pushManager.subscribe()`
- **[E]** `register_push` command sent with subscription endpoint and keys
- **[E]** Banner dismissed

### TC-14.03 — Push subscription persisted on server 🟠
- **[S]** Check `~/.config/pimote/push-subscriptions.json`
- **[E]** Contains the subscription record with endpoint and keys

### TC-14.04 — OS notification when app closed 🔴
- **[P]** Push enabled; session working
- **[S]** Close the browser tab
- **[S]** Wait for session to finish (agent_end)
- **[E]** OS notification appears with project name and "Session has finished working" (or first message preview)
- **[E]** Click notification → app opens/focuses

### TC-14.05 — In-app notification when app focused 🟠
- **[P]** Push enabled; viewing session A; session B working in background
- **[S]** Session B finishes
- **[E]** NO OS notification (app is focused)
- **[E]** Service worker posts `push_notification` message to client
- **[E]** Session B's `needsAttention` set to true; orange dot visible

### TC-14.06 — Notification for viewed session suppressed 🟡
- **[P]** Currently viewing session A
- **[S]** Session A finishes
- **[E]** Push notification still sent by server (server doesn't know if app is focused)
- **[E]** But service worker checks if app is focused — if focused, posts message instead of OS notification
- **[E]** If viewing session, `needsAttention` NOT set (handled by `agent_end` logic)

### TC-14.07 — Push with firstMessage context 🟡
- **[P]** Session had a first user message "Fix the login bug"
- **[S]** Session finishes → push sent
- **[E]** Notification body: `Session finished: Fix the login bug`

### TC-14.08 — Unregister push subscription 🟡
- **[S]** (Via raw WS) Send `unregister_push` with the endpoint
- **[E]** Subscription removed from server; file updated

### TC-14.09 — Expired subscription cleanup 🟡
- **[P]** Push subscription endpoint returns HTTP 410 (Gone)
- **[S]** Server attempts to send notification
- **[E]** Expired subscription automatically removed from store

### TC-14.10 — Multiple subscriptions (multiple devices) 🟡
- **[S]** Register push from both phone and desktop
- **[E]** Both subscriptions stored
- **[E]** Session finishes → both devices receive notification

### TC-14.11 — Push delivery failure doesn't crash server 🟡
- **[P]** Push endpoint is unreachable (non-410 error)
- **[S]** Session finishes
- **[E]** Warning logged; server continues; subscription NOT removed

---

## TP-15: PWA Installation & Service Worker

### TC-15.01 — PWA installable on mobile Chrome 🟠
- **[S]** Open app on Android Chrome
- **[E]** "Add to Home Screen" banner appears (or available via menu)
- **[S]** Install
- **[E]** App icon (192px) appears on home screen; opens in standalone mode

### TC-15.02 — Service worker registers 🟠
- **[S]** Open app in browser; check DevTools → Application → Service Workers
- **[E]** `sw.js` registered and active

### TC-15.03 — PWA manifest valid 🟡
- **[S]** Check `/manifest.json` content
- **[E]** Contains: name, icons (192 + 512), start_url, display mode, theme/background colors

### TC-15.04 — Notification click focuses app 🟡
- **[P]** App installed as PWA; notification received
- **[S]** Click the notification
- **[E]** If app is open: focused. If app is closed: opens to `/`

### TC-15.05 — Service worker push handler with malformed data 🟡
- **[P]** Push event received with non-JSON data
- **[E]** Falls back to default: `projectName: 'Pimote', sessionId: ''`

---

## TP-16: Responsive Layout & Mobile UX

### TC-16.01 — Desktop layout 🟠
- **[S]** Open on desktop browser (>768px width)
- **[E]** Sidebar permanently visible on left
- **[E]** No mobile hamburger menu
- **[E]** Conversation fills remaining width

### TC-16.02 — Mobile layout 🟠
- **[S]** Open on phone or narrow browser (<768px)
- **[E]** Sidebar hidden by default; hamburger menu (☰) visible in header
- **[S]** Click hamburger
- **[E]** Sidebar slides in as overlay with dark backdrop
- **[S]** Click backdrop or X button
- **[E]** Sidebar closes

### TC-16.03 — Sidebar closes on Escape key 🟡
- **[P]** Mobile, sidebar open
- **[S]** Press Escape
- **[E]** Sidebar closes

### TC-16.04 — FolderList inline on mobile landing 🟡
- **[P]** No session selected, mobile viewport
- **[E]** FolderList shown inline in main content area (not just in sidebar)

### TC-16.05 — ActiveSessionBar on mobile 🟠
- **[P]** Multiple sessions open, mobile viewport
- **[E]** ActiveSessionBar renders below the message list, above InputBar
- **[E]** Pills are scrollable horizontally if many sessions

### TC-16.06 — InputBar touch interaction 🟡
- **[S]** On mobile, tap InputBar
- **[E]** Virtual keyboard appears; input field focused
- **[S]** Type and send
- **[E]** Works correctly; layout doesn't break with keyboard open

---

## TP-17: Auto-Compaction & Auto-Retry Events

### TC-17.01 — Auto-compaction start/end display 🟡
- **[P]** Session has auto-compaction enabled and threshold is reached
- **[E]** `auto_compaction_start` event sets `isCompacting = true`
- **[E]** UI shows compaction indicator (if displayed)
- **[E]** `auto_compaction_end` sets `isCompacting = false`

### TC-17.02 — Auto-retry events 🟡
- **[P]** Agent encounters a retryable error
- **[E]** `auto_retry_start` event received with attempt, maxAttempts, delayMs, errorMessage
- **[E]** `auto_retry_end` received with success/failure
- **[E]** No crash; conversation continues

### TC-17.03 — Set auto-compaction command 🟡
- **[S]** (Via raw WS) Send `set_auto_compaction` with `enabled: true`
- **[E]** Response: `success: true`
- **[E]** `autoCompactionEnabled` reflected in state

### TC-17.04 — Manual compact via CompactButton 🟡
- **[P]** Session is open and idle
- **[S]** Click the Compact button (shrink icon) in StatusBar
- **[E]** `compact` command sent with `sessionId`
- **[E]** Button shows spinner and "Compacting…" text while in progress
- **[E]** Button disabled during compaction
- **[E]** Conversation compacted; response received

### TC-17.05 — Compact button disabled states 🟡
| Condition | Expected |
|-----------|----------|
| No session open | Disabled |
| Session is compacting | Disabled, shows spinner |
| Session open, not compacting | Enabled |

---

## TP-18: Error Handling & Edge Cases

### TC-18.01 — Invalid JSON sent to WebSocket 🟡
- **[S]** Send `not json` via raw WS
- **[E]** Response: `{ id: "unknown", success: false, error: "Invalid JSON" }`

### TC-18.02 — Unknown command type 🟡
- **[S]** Send `{ "type": "nonexistent_command" }`
- **[E]** Response: `success: false, error: "Unknown command type: nonexistent_command"`

### TC-18.03 — Command without required sessionId 🟡
- **[S]** Send `{ "type": "prompt", "message": "test" }` (no sessionId)
- **[E]** Response: `success: false, error: "sessionId is required"`

### TC-18.04 — Command for non-existent session 🟡
- **[S]** Send command with `sessionId: "nonexistent-uuid"`
- **[E]** Response: `success: false, error: "Session not found: nonexistent-uuid"`

### TC-18.05 — close_session without sessionId 🟡
- **[S]** Send `{ "type": "close_session" }` (no sessionId)
- **[E]** Response: `success: false, error: "sessionId is required"`

### TC-18.06 — Concurrent opens for same folder 🟡
- **[S]** Rapidly send two `open_session` commands for the same folder simultaneously
- **[E]** Both succeed; two independent sessions created

### TC-18.07 — Client disconnects during streaming 🟠
- **[P]** Agent is actively streaming
- **[S]** Close the browser
- **[E]** Server logs disconnect; `cleanup()` runs
- **[E]** Session remains alive (not reaped immediately)
- **[E]** Agent may continue working; events buffered

### TC-18.08 — Extension error event 🟡
- **[P]** A pi extension throws an error
- **[E]** `extension_error` event received with error message and extension name
- **[E]** No server crash; session continues

### TC-18.09 — Prompt while session is streaming 🟡
- **[S]** Send `prompt` while session status is `working`
- **[E]** Either queued by pi SDK or error returned — verify behavior (no crash)

### TC-18.10 — Very long conversation (buffer overflow) 🟡
- **[P]** Buffer size = 1000; generate 2000+ events
- **[S]** Disconnect and reconnect with a very old cursor
- **[E]** `full_resync` returned (buffer overflow detected)

---

## TP-19: Security

### TC-19.01 — Directory traversal via static serving 🔴
- **[S]** `GET /../../etc/shadow`
- **[S]** `GET /..%2F..%2Fetc%2Fpasswd`
- **[E]** All attempts blocked; return 404 or SPA fallback

### TC-19.02 — WebSocket only on /ws path 🟡
- **[S]** Attempt WS upgrade on `/api/vapid-key`
- **[E]** Connection destroyed; upgrade rejected

### TC-19.03 — Malformed WS messages don't crash server 🟠
- **[S]** Send: empty string, `null`, `undefined`, `[]`, very large payload (1MB+)
- **[E]** Error response or silent drop; server stays up

### TC-19.04 — Push subscription data validation 🟡
- **[S]** Send `register_push` with malformed subscription (missing keys, empty endpoint)
- **[E]** Server handles gracefully; no crash (may store bad data — note as observation)

### TC-19.05 — Config file permissions 🟡
- **[S]** Check `~/.config/pimote/config.json` permissions
- **[E]** VAPID private key stored — file should not be world-readable (note: pimote does not set permissions explicitly; recommend 0600)

---

## TP-20: Performance & Stability

### TC-20.01 — High-frequency streaming events 🟡
- **[P]** Agent producing rapid `message_update` events (e.g., fast model)
- **[S]** Observe client performance
- **[E]** No UI freezes; text renders smoothly; no dropped events

### TC-20.02 — Large conversation rendering 🟡
- **[P]** Session with 100+ messages, long code blocks
- **[S]** Scroll through conversation
- **[E]** Scrolling is smooth; markdown rendering does not lag

### TC-20.03 — Multiple concurrent WebSocket clients 🟡
- **[S]** Open 2 browser tabs connecting to the same server
- **[E]** Each gets its own WsHandler; independent session subscriptions
- **[E]** No interference between clients

### TC-20.04 — Long-running server stability 🟡
- **[S]** Run server for 24+ hours with periodic session opens/closes
- **[E]** No memory leaks; idle sessions reaped; server responsive

### TC-20.05 — Event buffer memory bounded 🟡
- **[P]** Buffer capacity = 1000
- **[S]** Generate 5000+ events
- **[E]** Buffer size stays at 1000 (ring buffer wraps); no unbounded growth

### TC-20.06 — Push subscription file atomic writes 🟡
- **[P]** Subscriptions being modified
- **[S]** Kill server mid-write
- **[E]** On restart, file is either the old state or new state (atomic rename), not corrupt

---

## Test Execution Summary Template

| Test Case | Status | Tester | Date | Notes |
|-----------|--------|--------|------|-------|
| TC-01.01 | ⬜ | | | |
| TC-01.02 | ⬜ | | | |
| ... | | | | |

**Status Key:** ⬜ Not Run | ✅ Pass | ❌ Fail | ⚠️ Blocked | 🔄 Retest

---

## Risk Areas Identified During Analysis

1. **No authentication**: The server has no auth middleware. Anyone who can reach the server (even through the Cloudflare tunnel) has full access to open sessions, execute code, and kill processes. The `config.apiKey` field exists in the vision but is not implemented in the server code.

2. **Push subscription validation**: `register_push` stores whatever the client sends without validating the subscription structure. Malformed subscriptions could cause send failures later.

3. **Session takeover PID filtering**: The `kill_conflicting_processes` command accepts client-supplied PIDs. While it cross-checks against actual pi processes in the folder, the flow is: client sends PIDs → server validates they're pi processes in that folder → kills. This is sound, but worth verifying the validation is tight.

4. **Legacy SessionStore**: `session.svelte.ts` is retained but its event subscription is removed. Dead code that could confuse future maintenance.

5. **Event buffer coalescing discards streaming deltas on reconnect**: If a client reconnects during mid-message streaming, it won't receive the accumulated text deltas (they were coalesced away). The `message_end` event contains the full message, so the final state is correct, but there may be a brief gap in the streaming display after reconnect until the message completes.

6. **No rate limiting on WebSocket commands**: A malicious or buggy client could flood the server with commands.

7. **Select dialog options format mismatch**: The extension bridge sends the `options` parameter from `ui.select()` as a raw string array, but `ExtensionDialog.svelte` renders `option.label` and sends `option.value`. If the options arrive as plain strings rather than `{label, value}` objects, the dialog may render blank labels. This should be tested carefully.

8. **InputBar doesn't use `follow_up` command**: The protocol defines `follow_up` as a separate command, but the InputBar UI always sends `prompt` when not streaming. The `follow_up` semantic pathway exists on the server but is unreachable from the current UI. If `follow_up` has different behavior than `prompt` in the pi SDK, that difference is not being utilized.

9. **Textarea auto-resize cap**: The InputBar textarea caps at 200px height (~8 lines). Very long pasted content will require scrolling within the textarea. This is intentional but should be verified on mobile where screen real estate is limited.

10. **Markdown XSS protection**: The markdown renderer uses DOMPurify to sanitize output. Verify that malicious markdown (e.g., `<img onerror=...>`, `<script>` tags) is properly sanitized in rendered assistant messages.
