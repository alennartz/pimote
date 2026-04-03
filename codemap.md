# Codemap

## Overview

Pimote is a PWA + Node.js server for remote access to pi (a coding agent). npm workspace with four packages: shared protocol types, a Node.js HTTP+WebSocket server managing pi AgentSession instances, a SvelteKit PWA client (Svelte 5 runes, shadcn-svelte) for real-time conversation rendering, and a panels library for extensions to push structured card data. Supports multiple concurrent sessions, session ownership/takeover, Web Push notifications, extension UI bridging, and a real-time side panel displaying extension-provided cards.

```mermaid
graph LR
  Protocol --> Server
  Protocol --> Client
  Panels --> Server
  Server --> Client
```

### Key Flows

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  participant Pi as pi AgentSession

  C->>S: open_session (folder, session?)
  S->>Pi: createAgentSession()
  S-->>C: session_opened event
  C->>S: prompt { sessionId, message }
  S->>Pi: session.prompt()
  Pi-->>S: SDK events (agent_start, message_update, agent_end, ...)
  S-->>C: PimoteSessionEvents (live stream)
  C->>S: reconnect { sessionId, lastCursor }
  S-->>C: buffered_events | full_resync
```

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  participant Ext as pi Extension

  Ext->>S: UI call (select/confirm/input)
  S-->>C: extension_ui_request event
  C->>S: extension_ui_response command
  S-->>Ext: resolve promise with value
```

## Modules

### Protocol

Shared TypeScript types defining the WebSocket wire format between client and server.

**Responsibilities:** command types (client→server), event types (server→client), response envelope, session/message/folder data shapes, push subscription types, extension UI request/response types, slash command types, panel/card data types (Card, BodySection, CardColor, BodySectionStyle, PanelUpdateEvent)

**Dependencies:** none

**Files:**

- `shared/src/**`

### Server

Node.js HTTP + WebSocket server that hosts pi AgentSession instances and bridges them to remote clients.

**Responsibilities:** HTTP static serving + SPA fallback, WebSocket upgrade + message routing, client identity registry, session lifecycle (open/close/reconnect/idle-reap/takeover), pi SDK session creation + event subscription, event buffering with delta coalescing for reconnect replay, folder/session filesystem discovery, extension UI bridging (dialog→WebSocket round-trips, fire-and-forget→events, TUI-only→no-ops), extension command context actions, SDK message mapping, session conflict detection (external pi processes via /proc + remote pimote sessions), config loading + VAPID key management, Web Push notification delivery, git branch detection, slash command/autocomplete handling, client version mismatch detection, EventBus creation + panel channel wiring (detect/data listeners), per-session panel state tracking with throttled pushes, panel snapshot delivery on reconnect/session-switch

**Dependencies:** Protocol (wire format types)

**Files:**

- `server/src/index.ts` — entry point
- `server/src/config.ts` — config loading, VAPID key auto-generation
- `server/src/server.ts` — HTTP server, static files, WebSocket upgrade, client registry, version checking
- `server/src/ws-handler.ts` — per-connection command handler, multi-session routing, session ownership/displacement, conflict detection
- `server/src/session-manager.ts` — ManagedSession lifecycle, status tracking, event subscription, idle reaping, EventBus creation + panel listener wiring, throttled panel push scheduling
- `server/src/event-buffer.ts` — ring buffer, SDK→wire event mapping, streaming delta coalescing
- `server/src/message-mapper.ts` — SDK AgentMessage → PimoteAgentMessage conversion
- `server/src/extension-ui-bridge.ts` — extension UI calls → WebSocket events
- `server/src/panel-state.ts` — pure panel state helpers: applyPanelMessage (namespace→cards map), getMergedPanelCards (flatten + namespace-prefix IDs)
- `server/src/folder-index.ts` — filesystem scanning for project folders and sessions
- `server/src/takeover.ts` — /proc scanning for external pi processes, kill with SIGTERM/SIGKILL
- `server/src/push-notification.ts` — PushNotificationService, subscription CRUD, delivery
- `server/src/push-infrastructure.ts` — FilePushSubscriptionStore, WebPushSender
- `server/src/**/*.test.ts` — tests

### Client

SvelteKit PWA rendering pi conversations in real time with session/folder browsing, model/thinking controls, extension UI, and push notifications.

**Responsibilities:** WebSocket connection with auto-reconnect (backoff→connecting→syncing→ready), per-session cursor tracking, stable client identity, multi-session state management (SessionRegistry with $state() runes), streaming message accumulation with stable DOM keying, folder/session index browsing, streaming markdown rendering (smd + highlight.js), tool call visualization, model/thinking pickers, extension UI queue (inline select/confirm + modal input/editor), input bar with prompt/steer/follow-up/abort modes + slash command autocomplete, per-session draft persistence, fuzzy matching, service worker for push notifications, PWA install prompt, active session bar with status indicators, text-to-speech playback with swipe-to-reveal gesture, panel card display (desktop side panel + mobile overlay with toggle FAB)

**Dependencies:** Protocol (wire format types), Server (WebSocket API)

**Files:**

- `client/src/lib/stores/connection.svelte.ts` — WebSocket lifecycle, reconnect phases, cursor tracking, push re-registration
- `client/src/lib/stores/session-registry.svelte.ts` — SessionRegistry class, event routing, streaming message accumulation, session lifecycle helpers
- `client/src/lib/stores/session-registry.test.ts` — tests
- `client/src/lib/stores/index-store.svelte.ts` — folder/session index browsing state
- `client/src/lib/stores/command-store.svelte.ts` — per-session command cache
- `client/src/lib/stores/command-store.test.ts` — tests
- `client/src/lib/stores/extension-ui-queue.svelte.ts` — extension UI request queue, inline vs modal routing
- `client/src/lib/stores/input-bar.svelte.ts` — editorTextRequest store for extension setEditorText
- `client/src/lib/stores/speech.svelte.ts` — singleton speech playback state (speak/stop/playingKey)
- `client/src/lib/stores/panel-store.svelte.ts` — PanelStore class: reactive card list for viewed session, handlePanelUpdate/reset methods
- `client/src/lib/stores/speech.svelte.test.ts` — tests
- `client/src/lib/components/Panel.svelte` — side panel rendering card list with color-coded borders, header/body/footer sections
- `client/src/lib/components/MessageList.svelte` — scrollable message list with unified display entries, auto-scroll, and swipe-to-reveal TTS
- `client/src/lib/components/SwipeReveal.svelte` — swipe-to-reveal gesture wrapper component
- `client/src/lib/components/Message.svelte` — message rendering (user, assistant, custom, system)
- `client/src/lib/components/TextBlock.svelte` — streaming markdown rendering via smd
- `client/src/lib/components/ThinkingBlock.svelte` — collapsible thinking block
- `client/src/lib/components/ToolCall.svelte` — tool call display with streaming args/results
- `client/src/lib/components/StreamingCollapsible.svelte` — reusable collapsible pre block with show-more/less
- `client/src/lib/components/StreamingIndicator.svelte` — animated working dots
- `client/src/lib/components/InputBar.svelte` — prompt input with slash command integration
- `client/src/lib/components/CommandAutocomplete.svelte` — slash command autocomplete popup
- `client/src/lib/components/InlineSelect.svelte` — inline extension UI (select with 1-9/arrows, confirm with Y/N)
- `client/src/lib/components/ExtensionDialog.svelte` — modal extension UI (input, editor)
- `client/src/lib/components/ExtensionStatus.svelte` — extension status display
- `client/src/lib/components/StatusBar.svelte` — session status header
- `client/src/lib/components/ActiveSessionBar.svelte` — session tab bar with status dots
- `client/src/lib/components/FolderList.svelte` — folder browser
- `client/src/lib/components/SessionItem.svelte` — session list item
- `client/src/lib/components/ModelPicker.svelte` — model selection dropdown
- `client/src/lib/components/ThinkingPicker.svelte` — thinking level dropdown
- `client/src/lib/components/NotificationBanner.svelte` — push notification opt-in prompt
- `client/src/lib/components/InstallBanner.svelte` — PWA install prompt
- `client/src/lib/components/PendingSteeringMessages.svelte` — pending steering message display
- `client/src/lib/components/ui/**` — shadcn-svelte primitives (button, badge, dialog, dropdown-menu, input, scroll-area, separator)
- `client/src/lib/markdown-to-speech.ts` — pure function converting markdown to speakable plain text
- `client/src/lib/markdown-to-speech.test.ts` — tests
- `client/src/lib/smd-renderer.ts` — streaming-markdown renderer with highlight.js and URL scheme allowlisting
- `client/src/lib/smd-renderer.test.ts`, `client/src/lib/smd-underscore-fix.test.ts` — tests
- `client/src/lib/fuzzy.ts` — fuzzy matching utility
- `client/src/lib/fuzzy.test.ts` — tests
- `client/src/lib/utils.ts`, `client/src/lib/index.ts` — utilities
- `client/src/lib/highlight-theme.css` — syntax highlight theme
- `client/src/sw.ts` — service worker (push notifications, notification click handling)
- `client/src/routes/+page.svelte` — main page (session view or landing)
- `client/src/routes/+layout.svelte` — app shell, connection init, service worker registration, desktop panel integration (flex sibling), mobile panel overlay + toggle FAB
- `client/src/routes/+layout.ts`, `client/src/routes/layout.css` — layout config and styles
- `client/src/app.html`, `client/src/app.d.ts` — SvelteKit app shell
- `client/src/test/mocks/app-environment.ts` — test mock
- `client/static/**` — Static assets (PWA manifest & icons, robots.txt)
- `client/svelte.config.js`, `client/vite.config.ts`, `client/vitest.config.ts` — build config

### Panels

Workspace package (`@pimote/panels`) for extensions to push structured card data into the pimote side panel via pi's EventBus.

**Responsibilities:** card/panel data types (Card, BodySection, CardColor, BodySectionStyle, PanelHandle, PanelMessage), pimote runtime detection via synchronous EventBus round-trip, scoped panel handles with namespace isolation and handle deactivation on re-detect

**Dependencies:** pi SDK (`ExtensionAPI` type only)

**Files:**

- `packages/panels/src/index.ts` — re-exports types and detect function
- `packages/panels/src/types.ts` — Card, BodySection, CardColor, BodySectionStyle, PanelHandle, PanelMessage type definitions
- `packages/panels/src/detect.ts` — detect() function: synchronous EventBus probe, handle creation with namespace scoping, previous-handle deactivation
- `packages/panels/src/detect.test.ts` — tests
