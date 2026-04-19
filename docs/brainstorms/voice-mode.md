# Voice mode for pimote

## The idea

Give pimote a voice modality, initially targeted at fully hands-free use (driving, Android Auto). Reuse **speechmux** as the voice engine, and adopt **voxcoder**'s interpreter pattern + hands-free prompt-engineering. Voxcoder's own server and Android stack are not reused — its contribution is ideas and prompts, not code.

## Direction

### Topology

```
           Android app (SelfManaged ConnectionService)
              │                                    │
   control / signaling                         WebRTC audio
   (existing pimote WS                         (TURN via
    client-server protocol)                     Cloudflare Calls)
              │                                    │
              ▼                                    ▼
         Pimote server  ◄─ WS LLM-shaped ─ Speechmux sidecar
              │
              ▼
      Pi session whose PRIMARY agent is the Interpreter
              │    subagent spawns
              ▼
      Worker pi agent(s)  (actual coding work)
```

- **Pimote server is the orchestrator.** It spawns speechmux as a sidecar, relays its WS protocol into the pi session that plays the "LLM endpoint," and owns session lifecycle.
- **Speechmux does voice only** — STT, TTS, VAD, full-duplex audio, barge-in signalling. It uses its existing WS "LLM-ish" protocol; pimote speaks that protocol on behalf of pi.
- **Audio transport is WebRTC**, exposed publicly via **Cloudflare Calls / Realtime** for TURN. This is a distinct ingress from pimote's existing app tunnel.
- **The Android app is a pimote client.** It holds two connections to the pimote server: (a) the existing pimote client-server WS protocol for non-audio concerns, and (b) a WebRTC media path to speechmux, set up via (a).

### Role of the existing pimote client-server protocol

The Android app reuses pimote's existing WS protocol for everything that isn't audio, so voice doesn't fork a parallel control plane:

- **Session + project listing** drives which `PhoneAccount`s (and contacts) the Android app registers. Sessions appear and disappear as contacts as pimote's session list changes.
- **Project "hotline" contacts** (`*new session in <project>*`) call into pimote's existing "create session" API on dial.
- **Call signaling is a small extension to the existing protocol.** When the user dials, the Android app first tells pimote "I want a voice call bound to session X" (or "spawn session in project Y and bind"). Pimote responds with the info needed to establish the WebRTC media leg to speechmux (Cloudflare Calls room, token, etc.). Hangup, bind-change, and call-state events ride the same channel.
- **Displacement, ownership, and agent-finished push** — already defined for text sessions — extend naturally to voice: "another device is on a call with this session" is just another ownership state. In v1 this is exactly that — ownership transfer, not shared access (see Scope).
- **PWA coexistence during calls is v2.** In v1, a call-owned session displays a "voice call active on another device" indicator in the PWA and blocks input, matching pimote's existing single-owner model. Shared/observer access is the explicit v2 unlock.

Concretely, this probably means adding a handful of message types to the existing protocol (`call_bind`, `call_ready`, `call_end`, maybe `call_status` — snake_case to match existing convention), not a second protocol.

### The interpreter pattern (from voxcoder)

- A cheap, fast LLM sits as the **primary agent** in the pi session. Its job is conversational mediation, not code work.
- All actual code work is done through `my-pi` **subagents** that the interpreter spawns. The worker is a subagent; the interpreter is the parent.
- The interpreter's system prompt is adapted from voxcoder's `INTERPRETER_PROMPT`: split its tools into `[UserFacing]` and `[WorkerFacing]`, enforce tool-only output (non-tool text goes to the void), and translate permissions/questions/tool activity into audio-friendly speech.
- To the user, interpreter + worker appear as one. To the worker subagent, the interpreter is "the user."

**Important difference from voxcoder.** Voxcoder's interpreter passively observes _every_ SDK message emitted by the worker. The `my-pi` subagent protocol is narrower: the parent receives `agent_idle` / `agent_message` / completion notifications, not a continuous stream of the child's internal events. So the pi-interpreter can't just watch — it has to interact. Concretely it will need to: ask the worker for status on a schedule, rely on the worker pushing updates via `send`, or make tasks small enough that completion notifications are enough. Exact prompting and cadence are deferred; the asymmetry is a known property of the platform we're building on, not a bug.

**Why this pattern rather than a thinner approach.** A single LLM can't be simultaneously a great coding agent _and_ a great real-time voice conversationalist — the latency, model-size, and prompt-discipline trade-offs conflict. Even with the observation-asymmetry caveat above, splitting the roles is still a win. Splitting them means the voice loop runs on a cheap fast model tuned for dialogue, and the worker loop runs on whatever model pi is configured with. The interpreter also naturally absorbs problems we'd otherwise bolt on piecemeal: permission-prompt translation, question translation, silent-minute narration during long tool runs, and barge-in semantics.

### Barge-in and history walk-back

- On barge-in, speechmux sends a `rollback{heard_text}` frame to pimote — the _delivered prefix string_, not a character offset. Walk-back is content-matching, not offset math.
- Pimote performs character-precision walk-back on the **LLM context** for the interpreter session, using existing pi extension points:
  - `abort()` cancels the in-flight turn; `aborted:true` flags the last assistant message.
  - `before_provider_request` rewrites the in-flight payload each subsequent turn so the last assistant message is truncated to `heard_text` before the LLM ever sees it.
  - `appendCustomMessageEntry(..., display:false)` records the interruption as a hidden-in-TUI but in-LLM-context marker.
  - For larger walk-backs that must cross entry boundaries, `branchWithSummary(fromId, summary, fromHook:true)` provides semantic rewinds.
  - Mid-stream user speech during tool execution is delivered via `steer` / `followUp`.
- Worker-subagent history is untouched — workers never spoke to the user.
- **Persisted scrollback is append-only** (pi's SessionManager by contract). That means the PWA scrollback will show the full streamed assistant text — _including text the user never heard_. This is a deliberate fidelity split: the scrollback is a record of what TTS attempted; the LLM context is what the user actually heard. These are legitimately different views and we do not try to unify them. Improving persisted-entry truncation is tracked as upstream pi work, not a v1 requirement.

### Android client — v1

- Custom Android app using the **telephony SDK** (`SelfManaged ConnectionService`). **Not** the media SDK.
- No PSTN / SIP provider. "Calls" are WebRTC under the hood, registered with Android telecom so they behave like real calls to Android Auto, the steering wheel, and the notification shade.
- This gives Android Auto integration essentially for free: native "call [contact]" voice command, hardware answer/hangup/mute, call history, missed-call semantics.

### Sessions as contacts

- Each active pimote session is a **contact** in the Android app's calling UI.
- Each project has a `*new session*` hotline contact; dialing it spawns a fresh session.
- Android Auto's native contact picker becomes the session picker. No custom Auto UI.

### Scope — intentional YAGNI

In v1:

- Outbound voice from the Android app only. **PWA stays text-only.**
- **No PWA coexistence during an active voice call.** Pimote's session ownership model is single-owner today (unicast `sendSlotEvent` and `panel_update`). When a session is call-owned, the PWA shows a "🔊 voice call active on another device" indicator and blocks input. Introducing a multi-observer session model is deferred to v2. This is a deliberate scope cut in light of the single-owner refactor cost.
- **Walk-back is best-effort in the LLM context (character-precision via `before_provider_request`); scrollback shows the full streamed text.** See "Barge-in and history walk-back" above. Persisted-entry truncation is upstream pi work, not v1.
- **No agent-initiated incoming calls.** Push notifications remain as today. (Pimote's push payload schema already includes an `interaction` variant; extending to `call` later is cheap on the server side.)
- **No extra narration plumbing.** The silent-minute problem (agent in a long tool run) is handled by the interpreter's prompt — it is instructed to pre-announce long work and emit periodic status. If this proves insufficient we can add a structured "say this now" side-channel later (speechmux would need a new `speak` frame).
- **One voice call at a time per speechmux instance.** Speechmux currently has a single-call slot per process; concurrent voice calls would need one speechmux per call. Not an issue for a single-user driving scenario.

Intentionally deferred: PWA voice button, PWA coexistence during call, agent-initiated calls, dedicated tool-narration stream, multi-call routing, persisted-entry truncation upstream in pi.

### What voxcoder contributes

- **The interpreter pattern** (most of what's in `voxcoder/server/src/interpreter/`): the `[UserFacing]`/`[WorkerFacing]` tool split, tool-only output discipline, permission/question translation, session-start greeting behaviour.
- **Hands-free prompt engineering** for driving contexts — terseness, error tolerance, repetition-on-request, confirmation style.
- **Not** reused: voxcoder's server, Android app, Android Auto media-app approach.

## Key decisions and why

- **Pimote server orchestrates; speechmux is a sidecar.** Keeps speechmux a clean library/daemon and keeps session/folder/auth concerns in one place. Avoids embedding speechmux into pi.
- **Speechmux's WS LLM protocol is the seam.** Reuses work speechmux already did; avoids inventing a new IPC surface. Pimote plays the "LLM" role.
- **Voice reuses the existing pimote client-server protocol for control.** Session discovery, call signaling, displacement, and agent-finished push are already solved for text; extending them is cheaper and more consistent than inventing a parallel voice control plane.
- **Interpreter is the primary, worker is a subagent.** In the `my-pi` subagent protocol the parent-side has at least _some_ visibility (notifications on idle/message/completion) whereas the subagent side has none by default; putting the interpreter at the parent gives it the widest available view. Full voxcoder-parity observation isn't on offer, and we're not pretending otherwise.
- **Telephony SDK over media SDK.** Android Auto's media-app surface is designed for podcasts/music and fights voice-agent UX; the telephony surface gives us the controls we actually want (steering-wheel answer/hangup/mute, voice-command dialing, call-history semantics) for free via `SelfManaged ConnectionService`, without needing PSTN.
- **Sessions as contacts.** The telephony choice makes this metaphor available, and it collapses "how do I pick a session while driving" into "how do I call someone while driving" — a problem Android already solved.
- **PWA stays text-only in v1.** PWA voice is cheap _later_ once speechmux is reachable, but adding it now doubles the UX surface without validating the core loop. Defer.
- **Character-precision walk-back in LLM context; append-only scrollback.** Pi exposes enough primitives today (`before_provider_request`, `abort`, `steer`, `followUp`, `branchWithSummary`, `appendCustomMessageEntry(display:false)`) for the LLM to only ever see what the user actually heard. Pi's persisted entries are append-only by design, so the PWA scrollback shows the full streamed text. We treat the scrollback as a record of what TTS _attempted_ and the LLM context as what the user _heard_ — these are legitimately different views, not a bug, and we do not attempt to unify them in v1.

## Known readiness / gap summary (from exploration of speechmux, voxcoder, pimote)

Speechmux is a very good fit. The WS `LlmBackend` protocol + `WsBackend` already implement the exact seam the brainstorm assumes (pimote-plays-LLM, content-precision `rollback{heard_text}`); `vision.md` wording about speechmux owning history is stale relative to `DR-009` + `WsBackend`. WebRTC transport with Cloudflare Realtime TURN is implemented and tested, not sketched. STT/TTS/VAD is driving-grade for English. Small speechmux-side work for v1: the WS LLM listener binds _inside_ the call loop today (small refactor to bind at startup), single-call-slot-per-process is fine for v1 scope, and per-call auth-token minting if we want it is the one non-trivial change.

Voxcoder's interpreter prompt is ~80% portable: role framing, tool-only-output discipline, TTS style, greeting, connection-handling, permission-prompt phrasing + alternative flow + remember/rulePattern, question ID-suffixing, and the indefinite-wait-on-user-prompts pattern all carry over. The `<worker_output>` and `<autonomous_decisions>` sections assume full SDK-stream visibility from the worker and must be rewritten for `my-pi`'s notification-only model. Plan-review, permission-mode-switch tools, and SDK-batching are Claude-Agent-SDK-specific and dropped for v1. Voxcoder's ADR-004 (Android-Auto media-app) is a cautionary tale, not a blueprint — telephony via `SelfManaged ConnectionService` escapes every one of its constraints.

Pimote absorbs the control-plane extensions naturally — its WS protocol is easy to extend with `call_bind` / `call_ready` / `call_end` / `call_status` events (snake_case to match existing style). The single-owner session model is the biggest pimote-internal constraint; v1 scopes around it by not supporting PWA coexistence during a call. Pimote has no subprocess supervisor today — speechmux sidecar lifecycle is net-new but contained. `openSession` has no per-session interpreter configuration today; we need either an `openSession` parameter (role / systemPrompt) or a voice-scoped extension that sets it. Pimote has zero `my-pi` integration references today — the interpreter-is-primary topology works as long as `my-pi` is active in the session, which is a deployment concern, not a pimote code change.

## Open questions (for architect phase)

- **Interpreter's pi-session shape.** Is the interpreter a pi specialist agent in `my-pi`, a per-topic specialist in this repo, or a standard agent whose system prompt is set by a pimote extension? How does pimote select/configure it at call-setup time — `openSession` parameter or scoped extension?
- **Cross-subagent permission propagation.** Voxcoder intercepts permissions at the Claude SDK `canUseTool` hook inside the worker process. In a `my-pi` parent-interpreter / subagent-worker setup, the parent does not own the child's `tool_call` decisions. Either the worker is prompted to raise permission-style `send`s to the interpreter, or pi's `tool_call` hook needs to propagate across the subagent boundary. Which?
- **Interpreter↔worker interaction cadence.** Given `my-pi`'s notification-only visibility, what's the right pattern — periodic status polls via `send`, worker-initiated pushes, small-task decomposition so completions suffice, or a mix?
- **Interpreter model choice.** Needs to be fast, cheap, good at tool use + dialogue. No decision yet.
- **Speechmux lifecycle.** One long-lived shared sidecar (simpler, matches v1's single-call scope), or one per call (clean isolation, slower startup)? Who supervises — pimote's `index.ts` shutdown hook seems the natural owner.
- **Per-call auth tokens on speechmux `/signal`.** Do we mint per-call tokens (requires small speechmux change or a pimote-side proxy in front of `/signal`) or use a shared env token for v1?
- **Contacts-sync mechanism on Android.** Do session-contacts materialize via `PhoneAccount` registration alone, or also via ContactsProvider sync? How do we handle fork/switch/tree-nav generating new session IDs — per-project hotlines plus "resume last," rather than per-session contacts?
- **Exact shape of the call-signaling protocol extension.** Which new message types (`call_bind`, `call_ready`, `call_end`, `call_status`), and how do they interact with existing ownership/displacement? Ownership during a call: does the Android app's control WS hold the slot, or does the server own the session while both Android and PWA are observers (tied to the v2 coexistence story)?
- **Does `my-pi` push worker-subagent progress cards via `@pimote/panels`?** Verification. If not, adding it is my-pi-side work, not pimote work. Relevant to the "PWA panels reflect voice worker activity" claim _once_ coexistence-during-call exists in v2.
- **Cloudflare Calls envelope.** Cost, quota, latency, TURN-only vs SFU.
- **Upstream pi work (non-blocking).** Persisted-entry truncation for scrollback fidelity; cross-subagent `tool_call` hook propagation.
