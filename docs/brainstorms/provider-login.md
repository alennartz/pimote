# Brainstorm: Interactive Provider Login (`/login` for pimote)

## The idea

Give pimote an equivalent of the pi TUI's `/login` command: an interactive flow,
driven from the PWA, for logging into OAuth **subscription** model providers
(Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot) so a remote pimote user can add
those providers without SSHing into the server box or hand-editing `auth.json`.

The real motivation is plainly "how else am I supposed to add model providers?" —
there is currently **no** way to add an interactive-auth provider to a running
pimote deployment from the client.

## Scope

**In scope:** the interactive OAuth flows only.

**Out of scope (deliberately):** API-key providers (paste a key into `auth.json`) and
custom providers (`models.json` endpoint + model definitions). Rationale: these are
"file on disk" — the operator does them by hand on the server, or bootstraps them with
the agent itself once at least one model is working. They don't need UI. At most we
document the manual path. This keeps the build narrow (YAGNI on the solution).

## Key facts that shaped the design

- **Auth is already wired, end to end, except for the interactive entry point.**
  `server/src/session-manager.ts` already constructs one shared `AuthStorage.create()`
  and a `ModelRegistry`, threaded into every pi session. Storage and _consumption_ of
  credentials work today. The only gap is a way to _run the interactive login_ remotely.
  pi exposes this programmatically: `authStorage.login(providerId, callbacks)`.

- **Auth is server-global, not per-session.** There is one `AuthStorage` for the whole
  server, shared by all sessions and all connected clients. So `/login` is not really a
  session operation — it mutates global server state. This is _why_ the login
  orchestration must be its own server-side concern, not jammed into session handling.

- **Two provider shapes, with very different UX:**
  - **Device-code** (GitHub Copilot): show a URL + short code, poll. No redirect. Remote-
    friendly by nature, zero paste friction. Clearly the nicer UX.
  - **Authorization-code + PKCE + localhost callback** (Claude, ChatGPT): pi spins an HTTP
    server on the _pimote server's_ `localhost:<port>`. The user's phone can't reach that
    redirect, so after login the browser shows a "can't connect" page — the user copies the
    code/URL from it and pastes it back. pi parses either a full redirect URL or a bare code.

## Key decisions (with reasoning)

1. **A `/login` equivalent, surfaced as a command, not a settings page.**
   The user wants an interactive flow "through a command." Entry point is `/login` in the
   PWA input bar.

2. **Server: a standalone login orchestrator (server singleton).**
   It owns the shared `AuthStorage` + `ModelRegistry`, lists OAuth providers, and runs
   `authStorage.login(id, callbacks)`, translating each pi callback (`onSelect`, `onAuth`,
   `onDeviceCode`, `onPrompt`, `onManualCodeInput`, `onProgress`, `signal`) into typed
   protocol steps. It is **not** per-session; `ws-handler` just routes `/login`'s protocol
   messages to it. Reasoning: auth is global state, so the orchestrator's lifetime and
   ownership shouldn't be tied to any one session.

3. **Client: a bespoke login modal (not the generic extension-UI dialogs).**
   Provider picker → a reactive "flow view" that renders whatever step the server emits:
   open-URL + paste field, device-code + waiting, generic prompt, progress, terminal
   success/error. New, purpose-built protocol messages. Reasoning: the open-URL-then-come-
   back-and-paste sequence is too specific to render well as a string of generic dialogs;
   a purpose-built modal gives a tappable "open auth page" button, live device-code display,
   and clear paste-back guidance.

4. **Server architecture and client UI are independent axes.**
   The clean server-side separation (login as its own concern) holds regardless of which UI
   we pick. We are not coupling "bespoke modal" to any particular server shape — the UI is
   just one consumer of the orchestrator's step events.

5. **Accept paste-back for Claude/ChatGPT; use device-code for Copilot.**
   We're impersonating the first-party CLI OAuth clients (pi embeds Anthropic's and OpenAI's
   privileged `client_id`s). Their `redirect_uri` is pinned, provider-side, to a localhost
   callback we don't own and can't re-register against our PWA domain — so redirecting auth
   back to a pimote URL is **impossible**, not merely unchosen. Device-code is the clearly
   preferable UX but pi only implements it for Copilot; Claude/ChatGPT are PKCE+callback
   only. So paste-back is the only path those two offer. The modal's copy must explicitly
   warn that the connection-error page is expected and to copy its URL.

6. **PWA only. Android explicitly excluded.**
   Android is voice-first with no real paste affordance; an interactive paste-back login
   there makes no sense.

7. **Security posture: no new trust boundary.**
   Any connected pimote client can already drive the agent (run arbitrary code), so letting
   a connected client add a provider / consume the operator's subscription introduces no new
   exposure. Worth a one-line note, not a gate.

## Direction

Build a server-side login orchestrator that drives `authStorage.login()` and emits typed
login-step protocol events, plus a `ws-handler` `/login` route, plus a bespoke PWA login
modal that renders those steps. Support all three OAuth providers in one release: device-
code for Copilot, paste-back for Claude/ChatGPT. After a successful login, rebuild the
model registry and get the new models in front of connected clients.

## Open questions (for architecting)

- **Model-registry refresh:** exact pi `ModelRegistry` reload/reset API after a new
  credential lands (`resetOAuthProviders` / reload?), and how pimote pushes the updated
  model list to connected clients so their model pickers see the new models without a
  reconnect.
- **Softening paste-back:** can Claude's flow (the `code=true` authorize param) be driven so
  the post-auth redirect lands on a clean provider-hosted code-display page instead of a dead
  localhost page? If so, "copy a code off a normal page" beats "copy a URL off an error page."
  Verify before promising it.
- **Concurrency:** two clients invoking `/login` at once against global auth state — serialize,
  or last-write-wins per provider? Low stakes (effectively single-operator), but decide.
