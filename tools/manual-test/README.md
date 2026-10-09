# Manual-test tools

Index of automated drivers used by the manual-test skill. Each entry:
purpose, invocation, inputs, outputs, prerequisites. New tools must be
registered here.

See `PLAN.md` in this directory for the list of primary user journeys
and which tool (if any) drives each.

## Shared helpers

### lib/report.mjs

Shared ✓/✗/⊝ reporter: `makeReporter(prefix)` returns `{ assert, soft,
section, log, stats, softFailures }`. `assert` counts hard failures (they
drive the exit code); `soft` records environment-bounded items that never
fail a run. Every tool builds on this instead of its own counters.

### lib/sandbox.mjs

Shared sandbox/server boot for tools that run a real pimote: `freePort()`,
`gitInit(dir, branch, { dirty, commit })`, `writePersona(dir, name,
description)`, `seedSession(sessionsRoot, projectDir, userText,
assistantText, { at })` (fabricated pi session jsonl under the SDK-exact
session-dir encoding; `at` fixes entry timestamps for recency fixtures),
`startPimote({ port, sandboxHome, agentDir, configPath, logPath })`,
`stopPimote(child)`, `waitForListening(child, port, logPath)`. Each tool
spawns its own child and kills only that PID.

### lib/ws-probe.mjs

Second protocol client for two-client assertions: `WsProbe(port,
clientId)` with `open()`, `send(payload)`, `listFolders({ includeArchived,
repin, query, limit })` (accumulates a complete listing while adopting each
response's pin; returns `windowPaths`/`windowCount` for duplicate and stream
checks), `eventsSince(since, type)`, `waitForEvent(type, predicate,
timeoutMs)`, `close()`.

### lib/browser.mjs

agent-browser CLI wrapper factory: `makeBrowserHelpers({ session, log })`
returns `browser()` (raw CLI passthrough with transient-failure retries),
`evalBrowser`, `fillSelector` (Svelte-safe input filling), `typeBurst`
(sub-debounce rapid typing), `wait`, virtualized-folder-list helpers
(`revealFolder`, `rowText`, `rowBlockText`, `rowIcon`, `rowRenderedNow`,
`starOnRow`, `openRowMenu`, `clickMenuItem`, `clickDialogButton`,
`folderScrollTop`, `folderScrollStep`), and a page-side WebSocket
instrumentation probe (`installSocketProbe`, `sentLog`, `resetSent`,
`closeLatestSocket`, `socketCount`) for request-count assertions and forced
reconnects. The probe wraps `WebSocket.prototype.send` after page load —
count only request deltas taken after installation.

### lib/session-dir.mjs

Single source of truth for the pi session-dir encoding used when smokes
fabricate session jsonl fixtures. The SDK (verified against 0.87.1,
`dist/core/session-manager.js` `getDefaultSessionDirPath`) encodes a
cwd as `--${resolve(cwd)…}--` under `<agentDir>/sessions/` — resolve
first, then strip the leading slash and replace every `/` `\` `:` with
`-`. Smokes must seed with that exact encoding or `SessionManager.list()`
(which reads only the one encoded dir) will not find the fixture.

- `seedSessionDir(sessionsRoot, cwd)` — canonical dir for writing fixtures
  (always SDK-exact). Use this in every `seedSession`-style helper
  (`lib/sandbox.mjs` `seedSession` wraps it).
- `sessionDirCandidates(sessionsRoot, cwd)` / `existingSessionDirs(…)` —
  both-era-aware lookups (SDK-exact first, then the pre-0.76 raw-string
  encoding) for reading or cleaning pre-existing fixtures seeded under
  either encoding.

## Tools

### voice-mock-smoke

**Purpose:** Exercise the pimote-side voice-mode pipeline end-to-end
without a real speechmux binary. Covers the `VoiceOrchestrator`
lifecycle, `bindCall` / `endCall` wire round-trip, displacement with
`force: true`, UI-bridge `isVoiceModeActive` predicate behaviour, and
the pure extension-runtime reducers' handling of synthetic speechmux
frames (user / abort / rollback). Drives journey 8 in `PLAN.md`.

**Location:** `scripts/voice-mock-smoke.mjs`

> Location note: this script predates the `tools/manual-test/`
> convention. Future voice-specific manual-test tooling should live
> under `tools/manual-test/<tool>/`; the existing script is left
> in-place to keep the plan-step deliverable references stable.

**Invocation:**

```bash
# Build the workspaces first so dist/ artifacts exist.
npm run build
node scripts/voice-mock-smoke.mjs
```

**Inputs:** none (all seams injected as fakes).

**Outputs:** stdout assertions; non-zero exit code on any failure.

**Prerequisites:** workspaces built (`server/dist`, `packages/voice/dist`,
`shared/dist`). No real speechmux, browser, or network required.

### static-host-smoke

**Purpose:** Exercise the server-side static-host pipeline end-to-end
without booting the full pimote server or requiring an LLM. Covers the
shipped `InMemoryStaticHostRegistry`, `FileStaticHostStore`,
`gcStaticHostStore`, `serveStaticHostRoute`, `executeRegisterTool`,
`executeRemoveTool`, slug validation + collision resolution,
persistence + replay across session evict/rehydrate, and boot-time GC
of orphan store files. Drives static-resources tests 1–11 in
`docs/manual-tests/static-resources.md`.

**Location:** `tools/manual-test/static-host-smoke/static-host-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/static-host-smoke/static-host-smoke.mjs
```

**Inputs:** none (uses `fs.mkdtemp` for an isolated bundle + store dir).

**Outputs:** per-test ✓/✗ lines on stdout; non-zero exit on any failure.

**Prerequisites:** workspaces built (`server/dist`, `shared/dist`). No
real network, browser, or LLM required.

### static-host-pwa-smoke

**Purpose:** Verify the client-side behaviours the test-review phase
deferred for static-resources: `Panel.svelte` rendering `Card.href`
as a clickable `<a>`, the service worker passing `/s/*` through to the
network unmodified, and browser-back returning to the session view
after viewing a hosted bundle. Drives static-resources tests 12–14.

**Location:** `tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs
```

**Inputs:** none. The script builds a fresh sandbox under `os.tmpdir()`
(its own `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`), fabricates a
pi session jsonl on disk, seeds the static-host persistence file,
boots `bin/pimote.js` on a free local port, and drives the PWA via
`agent-browser` against that sandboxed instance.

**Outputs:** per-test ✓/✗ lines on stdout; non-zero exit on any failure.
On failure the sandbox directory is preserved and its path printed for
inspection.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser`
on `PATH`, writable `os.tmpdir()`. The script tracks the child PID it
spawns and only kills that PID on teardown — it never uses
pattern-based `pkill` against shared binary paths.

### cost-accumulation-smoke

**Purpose:** Verify the per-session lifetime dollar cost surfaced in the
StatusBar (the `cost-accumulation` topic). Covers the full server +
client path without a live LLM: fabricates pi session JSONLs whose
assistant entries carry real-format `usage.cost.total` values (which
pi's `SessionManager` rehydrates into the in-memory branch on open —
the same path the plan relies on for restart survival), then asserts:
(1) `get_session_meta` succeeds with a numeric `lifetimeCostUsd` equal
to the sum over _assistant_ entries only (user / toolResult /
`model_change` entries excluded); (2) the StatusBar renders the
`formatSessionCost` figure (`$1.23`) for a priced session; (3) a
zero-spend session reports `lifetimeCostUsd: 0` and renders no
`[title="Session cost"]` span. Exercises StatusBar rendering within
the connect-and-open primary journey.

**Location:** `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs
```

**Inputs:** none. Builds a fresh sandbox under `os.tmpdir()` (its own
`HOME` + XDG dirs), fabricates two pi session JSONLs (priced +
zero-spend), boots `bin/pimote.js` on a free local port, checks
`get_session_meta` directly over the WebSocket, and drives the PWA via
`agent-browser` to assert the rendered StatusBar figure.

**Outputs:** per-test ✓/✗ lines + a `priced-statusbar.png` /
`zero-statusbar.png` screenshot pair in the sandbox; non-zero exit on
any failure. On failure the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser`
on `PATH`, writable `os.tmpdir()`. Tracks and kills only the child PID
it spawns — no pattern-based `pkill`. No real LLM, speechmux, or
network required.

### streaming-code-highlight-smoke

**Purpose:** Verify the FINALIZED render contracts of the `write` tool
visualization (the `streaming-code-highlight` topic) without a live LLM:
fabricates a pi session with completed `write` tool calls (code + markdown,
short + long), boots pimote, opens it in the PWA via `agent-browser`, and
asserts (1) mode routing by extension (`.ts`→highlighted `<pre><code>`,
`.md`→rendered markdown), (2) the copy button yields RAW source verbatim in
BOTH modes, (3) the show-more/collapse wrapper bounds long files in BOTH modes,
(4) real hljs span markup in code mode, and (5) rendered markdown + highlighted
inner fence in markdown mode. Exercises the settled half of journey 2's
tool-call visualization.

> Harness limitation: disk-fabricated sessions show the settled state only, so
> the streaming-only behaviors (auto-expand/collapse during a write stream,
> mid-stream highlight in the write view) are NOT exercised here — their logic
> is covered by client unit tests. See
> `docs/manual-tests/streaming-code-highlight.md`.

**Location:** `tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox; `SCH_SHOT=<path>` optionally
redirects the coherence screenshot outside the sandbox).

**Outputs:** per-test ✓/✗ lines + a `write-blocks.png` screenshot; non-zero exit
on any failure. On failure the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on PATH,
writable `os.tmpdir()`. Tracks and kills only the child PID it spawns. No real
LLM, speechmux, or network required.

### provider-login-smoke

**Purpose:** Exercise the interactive `/login` OAuth provider flow (the
`provider-login` topic) end-to-end without real subscription credentials.
Boots a real pimote against a sandboxed, credential-free HOME and drives the
real PWA + real pi-SDK `AuthStorage.login` up to the auth-URL / device-code /
paste step. Asserts: (1) typing `/login` opens the LoginDialog and posts no
user message; (2) `getOAuthProviders` lists Anthropic / GitHub Copilot /
ChatGPT with no logged-in badge in a fresh sandbox; (3) HEADLINE — the
Anthropic (paste-back) flow renders the "Open auth page" link (real
`claude.ai/oauth/authorize` URL) AND a working paste field simultaneously,
with the link surviving pi's immediately-following manual-code prompt step
(the review #1 critical fix / `authInfo` latch); (4) the GitHub Copilot
device-code flow answers the enterprise prompt and renders the real device
user code + verification link; (5) cancel closes the dialog with no stale
"Login failed" screen; (6) a concurrent `login_begin` while a flow is
in-flight is rejected `{ ok:false, reason:'busy' }` by the server
single-flight guard.

> Environment bound: completing a real token exchange needs real subscription
> credentials, unreachable here. The harness stops at the auth-URL /
> device-code / paste step and never submits a real code. Anthropic/OpenAI
> auth-URL emission is fully local (PKCE + localhost callback); Copilot
> device-code uses real network to `github.com/login/device/code`
> (unauthenticated device-flow start) — if unavailable, test 4 reports
> environment-bounded instead of failing.

**Location:** `tools/manual-test/provider-login-smoke/provider-login-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/provider-login-smoke/provider-login-smoke.mjs
# Keep the coherence screenshots outside the (auto-removed) sandbox:
PL_SHOTS=/tmp/pl-shots node tools/manual-test/provider-login-smoke/provider-login-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox with its own HOME + XDG dirs;
`PL_SHOTS=<dir>` optionally redirects the screenshots outside the sandbox).

**Outputs:** per-test ✓/✗/⊝ lines + `01-picker.png` / `02-anthropic-auth.png` /
`02b-after-cancel.png` / `03-copilot-device.png` screenshots; non-zero exit on
any hard failure (environment-bounded items do not fail the run). On failure
the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
PATH, writable `os.tmpdir()`. Tracks and kills only the child PID it spawns.
No real LLM, speechmux, or subscription credentials required; Copilot test 4
uses real network to github.com (degrades to environment-bounded if absent).

### at-file-syntax-smoke

**Purpose:** Exercise TUI-style `@`-file-path autocomplete in the web
InputBar (the `at-file-syntax-web` topic) end-to-end without a live LLM.
Boots a real pimote against a sandboxed HOME with a fabricated on-disk pi
session whose cwd is a known project tree (`src/`, `docs/`, a spaced
`my dir/`, `top.txt`). Three layers: (A) drives the `complete_file_refs`
WebSocket endpoint directly — `@` cwd listing, bare single-segment query,
last-slash scoping (`@src/`, `@src/ind`), quoted spaced token (`@"my d` →
`@"my dir/"`), and quoted-directory drill-in (`@"my dir/` →
`@"my dir/note.txt"`, the review-finding-#2 guard); (A2) boots a second
pimote with `fd`/`fdfind` stripped from `PATH` and asserts
`complete_file_refs` returns `items: []` plus exactly one (one-time)
`extension_ui_request` notify warning; (B) drives the real InputBar via
`agent-browser` — `@` opens the fd-backed dropdown, file selection inserts
`@path` and closes, directory selection inserts `@path/` and keeps the
menu open to drill in (including the quoted `@"my dir/` case), `@` fires
mid-line, `/` slash completion stays mutually exclusive, and the composed
`@path` token appears verbatim in the optimistic user message (no
server-side expansion). Drives the prompt-composition half of journey 2 in
`PLAN.md`.

> Harness limitation: no live LLM, so the _send_ path is verified via the
> optimistic user-message echo plus the structural fact that
> `prompt`/`steer`/`follow_up` forward `command.message` unchanged. `steer`
> / `follow_up` are not driven live (same forward-unchanged handler as
> `prompt`). See `docs/manual-tests/at-file-syntax-web.md`.

**Location:** `tools/manual-test/at-file-syntax-smoke/at-file-syntax-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/at-file-syntax-smoke/at-file-syntax-smoke.mjs
# Keep the coherence screenshot outside the (auto-removed) sandbox:
AT_SHOT=/tmp/at-file-syntax.png node tools/manual-test/at-file-syntax-smoke/at-file-syntax-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox with its own HOME + XDG
dirs; `AT_SHOT=<path>` optionally redirects the coherence screenshot
outside the sandbox).

**Outputs:** per-test ✓/✗ lines + an `at-file-syntax.png` screenshot;
non-zero exit on any failure. On failure the sandbox is preserved and its
path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
PATH, `fd` on PATH (Phase A/B need it; Phase A2 deliberately hides it),
writable `os.tmpdir()`. Tracks and kills only the child PIDs it spawns —
no pattern-based `pkill`. No real LLM, speechmux, or network required.

### file-downloads-smoke

**Purpose:** Exercise the PWA file-download journey against a real sandboxed
pimote server: an offered multi-item snapshot produces one exact-item toast,
dismissing it leaves a session-local inbox, the native link downloads live
bytes and consumes its opaque id once, sibling registrations survive, another
session cannot see the inbox, and a server restart/reopen silently restores the
pending item. The harness uses a tiny sandbox-only pi extension to emit the
same typed offer event a live `pimote_send_file` call would publish; the
manager, HTTP route, WebSocket reducer, and PWA are real.

**Location:** `tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs
# Optional coherence screenshot outside the auto-removed sandbox:
FD_SHOT=/tmp/file-downloads.png node tools/manual-test/file-downloads-smoke/file-downloads-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox; `FD_SHOT` optionally chooses a
screenshot path).

**Outputs:** per-check ✓/✗ lines, a coherence screenshot, and a non-zero exit
on hard failure. On failure the sandbox is preserved and its server log/path
are printed. The source fixture is never deleted by the route.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
`PATH`, writable `os.tmpdir()`. No live LLM or OS push subscription is
required; focused/background push planning and notification-intent contracts
are covered by the client unit tests.

### update-notification-smoke

**Purpose:** Exercise the update-availability notification end-to-end with a deterministic npm-registry fixture. Boots the real server in an isolated HOME, injects controlled equal/older/newer registry responses, probes the `update_available` WebSocket event, and drives the real PWA via `agent-browser` to verify the banner, dismissal-to-ambient markers, persistence across reload/reconnect, newer-release reappearance, banner-slot coexistence, and the `updateCheck: false` no-network path.

**Location:** `tools/manual-test/update-notification-smoke/update-notification-smoke.mjs`

**Invocation:**

```bash
npm run build
UN_SHOTS=/tmp/update-notification-shots node tools/manual-test/update-notification-smoke/update-notification-smoke.mjs
```

**Inputs:** none by default. `UN_SHOTS` optionally keeps coherence screenshots outside the disposable sandbox; `UN_KEEP=1` preserves the sandbox on a passing run.

**Outputs:** per-check `✓/✗` lines, mobile/desktop screenshots, and a non-zero exit on hard failure. On failure the sandbox and server log are preserved for inspection.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on `PATH`, writable `os.tmpdir()`. No real npm registry, LLM, or push subscription is required; `fake-registry.mjs` intercepts only the npm latest-version URL in the child server process.

### project-management-smoke

**Purpose:** Exercise the folder-management dashboard end-to-end (the
`project-management` topic, folder-model vocabulary). Boots a real pimote
server in an isolated HOME against a fabricated two-root folder tree (nested
entries at arbitrary depth beneath a _skipped_ wrapper — never inside
included git repos, a dirty repo, named branches, two persona folders via
`AGENTS.md` marker front matter, a shortcut-linked external repo via a
top-level out-of-tree symlink, a fabricated pi session), plus a folder-source
fixture module (missing repo entry provisioned by its `onFolderOpen` hook and
an unopened hub entry). Seeds a local model via `PI_CODING_AGENT_DIR` for the
manager LLM, and drives the real PWA via `agent-browser` plus a second
WebSocket probe client. Covers: sparse discovery shape (no depth bound,
skipped wrappers collapse into reach paths), FolderInfo defaults
(nature/persona/shortcutCount/missing/repo?/repos?/userTags?) and the four row icon
variants (code, code-hub, persona, persona-hub), `update_folder` /
epoch-stamped `folders_changed` delta sync (`changed` / `removedPaths`, both
directions), complete comparisons accumulated from small protocol windows
under each adopted token, explicit `includeArchived` probes and fresh-order
repins after discovery mutations, hub create/disband
round-trips with on-disk symlink + `git init` + root-anchored `.gitignore` +
`AGENTS.md` assertions, source-contributed tags and the `onFolderOpen`
provisioning hook, favorites (favorites-first ordering), archive/show-
archived, create-folder (mkdir + git init), resume of an existing session,
the active-session dot, virtualized row lookup through dashboard scrolling,
server-authoritative dashboard search and picker search (persona display names
included), the manager chat (streamed reply, `pimote_list_folders` +
`pimote_folder_tree` tool use, abort, ephemeral reset on reconnect), the
missing-member warning chip, the unscanned-cwd `classifyFolder` session
fallback (list/open in cwds outside the scan roots never lists or curates
them), legacy `multiRepo` registry read-compat (loads unchanged; the next
write persists `hubs`), and the mobile manager affordance. Tool-call and
assistant-reply detection is role-scoped (`.tool-block .tool-name`,
`.assistant-message`) so user prompt text cannot false-positive it. Manager
folder-count comparisons include archived rows and accumulate all windows.
The manager tool itself stays complete and unwindowed. Dashboard DOM rows
remain bounded, and session lists load only for rendered rows. Open/bound chat
session restoration stays independent of window fetches.

**Location:** `tools/manual-test/project-management-smoke/project-management-smoke.mjs`
(shared boot/probe/browser helpers from `tools/manual-test/lib/`).

**Invocation:**

```bash
npm run build
node tools/manual-test/project-management-smoke/project-management-smoke.mjs
# Keep coherence screenshots outside the (auto-removed) sandbox:
PM_SHOTS=/tmp/pm-shots node tools/manual-test/project-management-smoke/project-management-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox; `PM_SHOTS=<dir>` optionally
redirects screenshots; `PM_KEEP=1` preserves the sandbox on a passing run).
Expects the host's `~/.pi/agent/models.json` to contain the local `jetson`
provider for the manager-LLM phase; without it those tests report
environment-bounded instead of failing.

**Outputs:** per-check ✓/✗/⊝ lines, coherence screenshots, and a non-zero
exit on hard failure. On failure the sandbox and server log are preserved.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
`PATH`, `git` on `PATH`, writable `os.tmpdir()`. Tracks and kills only the
child PID it spawns. Requires network reachability to the model endpoint
named in `models.json` for the manager phase only.

### folder-paging-smoke

**Purpose:** Exercise server-side folder listing (the
`server-folder-list-paging` topic) end-to-end against a real sandboxed
pimote + real PWA over a ~250-row fixture (so the browser walks ≥3
continuation windows at the default 100-row window). Wire tier (WS probes):
window continuity over the full set through tiny windows (no duplicate or
skipped rows), pin contract (token adoption, omitted-token reuse,
cross-owner rejection, limit clamping, fresh-token repin, favorites-first),
curation edits resolving at query time without pin reordering, two-tier
search semantics (folder name/tag/persona-display-name tiers,
session name/firstMessage tier with exact `matchedSessionIds`, full-set
filtering, `includeArchived` × rows and totals), `file_put` → AGENTS.md
delta targeting (nested → deepest owning row; global instructions → no
delta), and discovery-added folders surfacing through `folders_changed`.
Browser tier (virtualized `FolderList` + socket instrumentation): bounded
rendered rows and lazy session loading (rendered rows only), deep-scroll
window continuity, curation edits mid-scroll (favorite/tag/archive) with no
silent skips, mid-scroll query-match shrink (archive + session delete),
server-authoritative search incl. debounced typing bursts and
`matchedSessionIds` session-list narrowing, explicit refresh (`repin`) and
reconnect cache-replace (no phantom rows, lost deltas heal), delta-arrived
rows findable by search, and the archive toggle reloading only
loaded/rendered session lists.

**Location:** `tools/manual-test/folder-paging-smoke/folder-paging-smoke.mjs`
(shared boot/probe/browser helpers from `tools/manual-test/lib/`).

**Invocation:**

```bash
npm run build
node tools/manual-test/folder-paging-smoke/folder-paging-smoke.mjs
# Coherence screenshots outside the sandbox + keep the sandbox:
FP_SHOTS=/tmp/fp-shots FP_KEEP=1 node tools/manual-test/folder-paging-smoke/folder-paging-smoke.mjs
# Smaller fixture for quick runs:
FP_FOLDERS=60 node tools/manual-test/folder-paging-smoke/folder-paging-smoke.mjs
```

**Inputs:** none by default (fresh `os.tmpdir()` sandbox). `FP_FOLDERS`
sets the filler folder count (clamped ≥ 30, default 245); `FP_SHOTS=<dir>`
redirects coherence screenshots; `FP_KEEP=1` preserves the sandbox on a
passing run.

**Outputs:** per-check ✓/✗/⊝ lines + coherence screenshots
(`01-dashboard.png`, `02-search.png`, `03-deep-scroll.png`,
`04-archived.png`, `05-reconnect.png`); non-zero exit on hard failure. On
failure the sandbox and server log are preserved.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
`PATH`, writable `os.tmpdir()`. Tracks and kills only the child PID it
spawns. No real LLM, network, or push subscription required.

### manager-tools-smoke

**Purpose:** Deterministic probe for the manager's pimote toolset (the
`folder-model-foundation` topic). Registers the shipped
`createManagerExtension` toolset against a capture-only stub pi
`ExtensionAPI`, then executes the folder-view tools through a real
`ManagerToolContext`: real `scanFolderModel` over a fixture tree, real
`FolderRegistry` over a temp store, and a hub built by the real `createHub`
(mkdir + absolute member symlinks + `git init` + root-anchored `.gitignore`

- generated `AGENTS.md`). Asserts, without any LLM: the registered names are
  the renamed ones (`pimote_list_folders` / `pimote_folder_tree`, no
  `*_projects`), `pimote_list_folders` returns complete FolderInfo rows with
  schema defaults, and `pimote_folder_tree` reports the sparse tree shape
  (occurrences with `path`/`via`/`entry`/`children`; hub member symlinks
  surface as `via: 'shortcut'` occurrences referencing the member entries;
  scan and shortcut occurrences share one entry object). Complements the
  LLM-driven manager-chat phase of `project-management-smoke`, which cannot
  force tool choice.

**Location:** `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs
```

**Inputs:** none by default (fresh `os.tmpdir()` sandbox; `MTMS_ROOT=<dir>`
reuses an existing fixture tree containing `<root>/alpha`, `<root>/beta` git
repos and an `<root>/omega` persona folder instead of fabricating one).

**Outputs:** per-check ✓/✗ lines on stdout; non-zero exit on any failure.

**Prerequisites:** workspaces built (`npm run build`), `git` on `PATH` (the
real hub materializer runs `git init`). No server, browser, network, or LLM
required.

### agents-md-editor-smoke

**Purpose:** Exercise the AGENTS.md editor journey (the `agents-md-editor`
topic) end-to-end against a real sandboxed pimote + real PWA: the home-page
"Agent instructions" button opens the config-file editor dialog on
`~/.pi/agent/AGENTS.md` (title, resolved path, content, toolbar), edit + save
round-trips to disk exactly, tag-wrap works freeform (inline wrap with
selection restored) and via `tagSnippets` snippet buttons (block insert at the
cursor), and cancel/discard-confirm gates every close path (Cancel →
confirmation, Keep editing, Esc veto, Discard leaves disk unchanged). Drives
journey 13 in `PLAN.md`.

**Location:** `tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs
# Keep the coherence screenshot outside the (auto-removed) sandbox:
AM_SHOT=/tmp/agents-md-editor.png node tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox with its own HOME + XDG dirs,
a seeded AGENTS.md, and `tagSnippets` in the pimote config; `AM_SHOT=<path>`
optionally redirects the coherence screenshot; `AM_KEEP=1` preserves the
sandbox on a passing run).

**Outputs:** per-check ✓/✗ lines + an `agents-md-editor.png` coherence
screenshot; non-zero exit on failure. On failure the sandbox and server log
are preserved.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
`PATH`, writable `os.tmpdir()`. Tracks and kills only the child PID it
spawns. No real LLM or network required.

### agent-browser (cross-repo skill)

**Purpose:** Drive PWA user journeys end-to-end via a headless-Chromium
CLI — `open`, `snapshot -i`, `click @ref`, `fill`, `eval`, `console`,
`screenshot`. The manual-testing skill's mandatory-reuse table lists it
as the default driver for browser / PWA journeys; this repo uses it to
drive journey 8's PWA half (Call button, full-screen calling-mode
surface, gesture-driven mute/hangup/abort).

**Location:** external skill at `~/.agents/skills/agent-browser/` — not
vendored into this repo. Installed globally as the `agent-browser` CLI.

**Invocation (journey 8 PWA half):**

```bash
# 1. Build + start pimote with a sandboxed XDG_CONFIG_HOME and a stub
#    voice block (see docs/manual-tests/voice-mode.md for the exact
#    config and the getUserMedia shim).
npm run build
XDG_CONFIG_HOME=... XDG_STATE_HOME=... node bin/pimote.js --port <free>

# 2. Drive the UI.
agent-browser open http://localhost:<free>/
agent-browser snapshot -i                     # find @refs
agent-browser click @<new-session-button>
agent-browser eval "$(cat patch-getusermedia.js)"  # real MediaStream shim
agent-browser click @<call-button>
agent-browser snapshot -i                     # expect calling-mode surface
                                              # (header + transcript + gesture zone)
# In-call interactions are gesture-driven: tap = mute toggle,
# swipe-up = hang up, swipe-down = abort. There is no inline
# `End call` button; drive hangup via a synthetic swipe-up
# pointer sequence on the gesture zone, or via
# `agent-browser eval 'window.__voiceCallStore?.endCall()'`
# when wired for tests. See docs/manual-tests/voice-call-
# fullscreen-ui.md for the recipe used in the most recent run.
agent-browser snapshot -i                     # calling mode gone, chat returns
```

**Inputs:** pimote server URL + session refs from each snapshot.

**Outputs:** snapshot diffs, screenshots (`agent-browser screenshot`),
console log (`agent-browser console`).

**Prerequisites:** `agent-browser` on PATH; pimote server running
locally; for voice-mode, a `getUserMedia` shim injected via
`agent-browser eval` because headless Chromium has no microphone and
`agent-browser` doesn't currently expose Chromium's
`--use-fake-device-for-media-stream` flag.
