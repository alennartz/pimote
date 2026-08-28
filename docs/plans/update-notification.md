# Plan: Update Notification

## Context

Tell a self-hosted pimote user when a newer `@pimote/pimote` has been published to npm. The
server checks the registry, and the PWA surfaces it as a banner that dismisses to a persistent
ambient marker. Notification only — self-update was deliberately cut (see brainstorm).

Brainstorm: [docs/brainstorms/update-notification.md](../brainstorms/update-notification.md)

## Architecture

### Impacted Modules

**Server** — gains an update-check module (below) and one new wiring point. `index.ts` constructs
the checker when enabled, warms its cache with a fire-and-forget call at boot, and logs the result.
`server.ts` calls `getStatus()` on each accepted WebSocket connection, after the existing
`version_mismatch` gate (`server.ts:214-236`), and sends the event to that client when the result is
non-null. `config.ts` gains an `updateCheck?: boolean` field.

The checker is an **optional dependency** of `createServer`. When the config disables it, `index.ts`
passes nothing and the connect path never calls it — the disabled build makes no network call at
all, not even a suppressed one. A single `if` at a single call site.

**Protocol** — one new event, `UpdateAvailableEvent`, added to the `PimoteEvent` union beside
`VersionMismatchEvent` (`shared/src/protocol.ts:1030`).

**Web Client** — gains an update store, a persistence key, one new banner component, and marker
renderings in three existing surfaces. `connection.svelte.ts` dispatches the new event alongside its
`version_mismatch` branch (`:190`).

### New Modules

**Update Check** — `server/src/update-check.ts`

Owns everything about "is a newer version published": registry access, caching, semver comparison,
release-URL construction, and failure suppression. Depends on `semver` and global `fetch`; nothing
in pimote depends on it except its two wiring points.

Its entire interface is one method returning one nullable value. TTL, single-flight coalescing, and
error handling are implementation, not interface.

### Interfaces

#### Update Check module

```ts
interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

interface UpdateChecker {
  getStatus(): Promise<UpdateStatus | null>;
}

function createUpdateChecker(opts: {
  currentVersion: string;
  fetchLatestVersion: () => Promise<string>; // seam: real registry adapter / test fake
  now?: () => number; // seam: clock, for TTL tests
  ttlMs?: number; // default 6 hours
}): UpdateChecker;
```

Contract:

- Returns `null` when no newer version exists **and** when the latest version is unknown. Collapsing
  those two is deliberate: no caller can act differently on them, so distinguishing them would only
  widen the interface.
- Returns non-null only when `semver.gt(latest, current)`. Strictly greater-than, not inequality —
  a dev clone or `install-local` build running ahead of the registry must not show a phantom update.
- Never rejects. Registry failures are swallowed; the call resolves with the cached value if one
  exists, otherwise `null`.
- Calls `fetchLatestVersion` at most once per `ttlMs`. Within the TTL, the cached value is returned
  without I/O.
- Concurrent calls on a cold or expired cache share **one** in-flight `fetchLatestVersion` call
  (single-flight). A reconnect storm produces one registry request, not one per connection.
- `releaseUrl` is `https://github.com/alennartz/pimote/releases/tag/pimote-v<latestVersion>`.

Internal seam, not part of the interface — a pure function computing the status from two version
strings, testable with no I/O:

```ts
function computeUpdateStatus(currentVersion: string, latestVersion: string): UpdateStatus | null;
```

The real adapter for the seam performs `GET https://registry.npmjs.org/@pimote/pimote/latest` and
reads `.version` from the JSON response.

#### Server wiring

`createServer` accepts `updateChecker?: UpdateChecker`. On each accepted WebSocket connection,
after the `version_mismatch` gate and handler registration, it calls `getStatus()` and sends an
`update_available` event to that connection when the result is non-null. Fire-and-forget: the
handshake is not blocked on the check, and the event may arrive a beat after connect.

`getVersion()` (`server/src/cli.ts:26`) supplies `currentVersion`.

#### Protocol

```ts
interface UpdateAvailableEvent {
  type: 'update_available';
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}
```

Server-to-client only; no corresponding command. The client never requests this and never templates
the URL — it renders what it is given.

#### Config

```ts
interface PimoteConfig {
  // ...
  /** Check npm for newer pimote releases. Default true. */
  updateCheck?: boolean;
}
```

Absent means enabled. Set by hand-editing the config file at `CONFIG_PATH` — deliberately **no** CLI
flag and **no** environment variable, and `pimote init` does not prompt for it. This resolves the
brainstorm's sharp question on opt-out mechanism: it is a set-once deployment preference, and the
systemd unit's `ExecStart` is generated (`scripts/install-systemd-service.mjs:30`), so a flag there
would be invisible and lost on regeneration. One mechanism, one place.

#### Client store

`client/src/lib/stores/update.svelte.ts`:

```ts
{
  readonly status: UpdateStatus | null;   // from the last update_available event
  readonly showBanner: boolean;           // status !== null && dismissedVersion !== status.latestVersion
  readonly showMarker: boolean;           // status !== null
  dismiss(): void;                        // persists status.latestVersion as dismissed
}
```

#### Client persistence

`client/src/lib/stores/persistence.ts`, following the existing keyed-accessor pattern:

```ts
function getDismissedUpdateVersion(): string | null;
function setDismissedUpdateVersion(version: string): void;
```

Key: `pimote:dismissedUpdateVersion`.

Dismissal is keyed on the **version string**, not a boolean. A boolean would silence every future
release forever. Version-keyed dismissal survives reloads and reconnects — essential, since a
connection-scoped dismissal would be useless on mobile, where reconnects are constant — while
letting each new release earn exactly one banner.

The ambient marker ignores dismissal entirely. That is the brainstorm's "dismiss to ambient"
decision made literal: dismissing removes the interruption, not the reminder.

#### Client surfaces

- **`UpdateBanner.svelte`** (new) — rendered beside `NotificationBanner` in `+page.svelte:39`.
  Shows running and available versions, a link to `releaseUrl`, and a dismiss control. Visible on
  `showBanner`.
- **Settings gear dot** — `+layout.svelte:297`, on `showMarker`. Reuses the dot-badge-on-an-icon
  pattern already used by the panel button at `:288`.
- **`SessionSettingsDialog` row** — running version, available version, release link. On
  `showMarker`. The dialog is session-titled but already displays server-global connection status,
  so global information here has precedent.
- **`StatusBar` item** (desktop) — same content, on `showMarker`. `StatusBar.svelte:1` documents
  that it and `SessionSettingsDialog` are twins; both change together.

Explicitly **not** `MobileRuntimeStatus`. That chip strip renders only when something is wrong; a
persistent version chip would make it always-on, permanently costing a row of vertical phone height.

#### Android Client — out of scope, no change required

The Android client surfaces nothing for updates. Verified safe: its polymorphic event deserializer
throws `UnknownPimoteEventTypeException` for types outside its v1 subset (`Protocol.kt:294`), and
`WsClient.kt:368` catches it and skips the message. `update_available` is therefore ignored without
error, and no Kotlin protocol-mirror change is needed.

### Technology Choices

**`semver` (new dependency)** — needed for a correct greater-than comparison. Hand-rolling was
rejected: the comparison must be `gt`, not `!==`, or every dev clone ahead of the registry shows a
phantom update, and hand-rolled semver comparison is a well-known source of subtle bugs.

**Plain `fetch` over `latest-version`** — Node 22 ships global `fetch`, the registry call is about
five lines, and it sits behind the injected seam regardless. `latest-version` would add a
transitive tree and its own failure modes while replacing almost no code.

**`update-notifier` rejected** despite being the ecosystem default. It is built for short-lived
CLIs: it populates its result from the _previous_ run's cache via a detached background check,
which is backwards for a daemon that restarts rarely, and it wants to print to stderr rather than
yield structured data.

### Decision Records Followed

**DR-033** (initiating client re-pulls models after login; no server broadcast) is binding here. An
earlier sketch had the checker push discoveries to all connected clients. DR-033 rejects exactly
that machinery for exactly this class of problem: pimote is single-operator, and staleness until
the next natural pull is acceptable. Applied here, the status is sent **on connect only** — there is
no fanout, no timer, and no lifecycle. A client learns of a new version on its next reconnect or
reload, which on mobile is near-continuous and for a once-per-8-days event is irrelevant.

Removing the fanout is also what makes the lazily-refreshing cache viable instead of a background
poller: with nothing consuming a discovery at the moment it happens, a timer has no purpose.

**This supersedes the brainstorm's Direction**, which described the server checking "on a cadence"
and pushing "to connected clients." That wording predates the DR-033 review. The accepted trade-off
is explicit: a long-lived client that never reconnects — realistically only a desktop tab left open
for days — will not see a new release until it reconnects or reloads. Mobile reconnects constantly,
so it is unaffected. The check still happens on a cadence in the sense that matters (bounded to one
registry request per TTL), but it is demand-triggered rather than timer-driven.

## Tests

**Pre-test-write commit:** `64acee2e261ccc555fc6bfb1d0c93d44765856c2`

### Interface Files

- `shared/src/protocol.ts` — shared `UpdateStatus` payload and `UpdateAvailableEvent` wire event added to the event union. `UpdateStatus` lives in the shared protocol so the checker, server, and client consume one definition.
- `server/src/update-check.ts` — `UpdateChecker` contract, options shape, and status type export.
- `server/src/server.ts` — optional `UpdateChecker` dependency added to `createServer`.
- `server/src/config.ts` — optional `updateCheck` deployment preference added to `PimoteConfig`.
- `client/src/lib/stores/persistence.ts` — dismissed-update-version persistence accessors declared.
- `client/src/lib/stores/update.svelte.ts` — `UpdateStore` public status, visibility, event-ingest, and dismissal surface declared.

### Test Files

- `server/src/update-check.test.ts` — checker comparison, release URL, failure suppression, TTL cache, and single-flight behaviors.
- `server/src/config-update-check.test.ts` — explicit true/false config preference parsing.
- `server/src/server-update-check.test.ts` — accepted WebSocket update-status check and event delivery wiring.
- `client/src/lib/stores/update-persistence.test.ts` — version-keyed localStorage round-trip and best-effort error behavior.
- `client/src/lib/stores/update.svelte.test.ts` — status ingestion, banner/marker visibility, version-keyed dismissal, newer-release reappearance, and reload persistence.

### Behaviors Covered

#### Update Check

- A published version strictly newer than the running version yields the current/latest versions and the canonical GitHub release URL.
- Equal and registry-ahead versions yield no update status.
- Registry failures never reject a status request; a cold failure yields no status and a refresh failure preserves the cached status.
- Calls within the TTL reuse the cached result, while expiry permits one refresh.
- Concurrent cold-cache callers share one registry request and receive the same status.

#### Server Wiring

- An accepted WebSocket connection invokes the optional checker after the version gate and sends a non-null result as an `update_available` event.

#### Config

- Explicit `updateCheck: true` and `updateCheck: false` values survive config loading.

#### Client Persistence

- The dismissed latest-version string round-trips under `pimote:dismissedUpdateVersion`, overwrites older values, and gracefully handles storage failures.

#### Client Update Store

- An incoming update event becomes the observable status and enables both banner and ambient marker.
- Dismissing the current version hides only the banner; the marker remains visible.
- A newer latest version raises the banner again after an older version was dismissed.
- Dismissal is read from persistence when a fresh store is constructed after reload.

**Review status:** skipped — test-review bypassed by skip decision

## Steps

**Pre-implementation commit:** `edc71288cf0220d7725aa772ab45d1206e88e95c`

### Step 1: Implement the cached update checker and npm adapter

Use npm workspace commands—not hand edits—to add the latest stable `semver` runtime dependency to both `package.json` (the published package manifest) and `server/package.json` (the source workspace), add its current type package to the server workspace if the resolved `semver` package does not provide declarations, and update `package-lock.json`.

Complete `server/src/update-check.ts` behind the existing `UpdateChecker#getStatus()` interface. Add a private pure `computeUpdateStatus(currentVersion, latestVersion)` helper that returns a status only when `semver.gt(latestVersion, currentVersion)` and builds the canonical `pimote-v<latestVersion>` GitHub tag URL. Keep cache timestamp, cached nullable status, and the optional in-flight promise inside each checker instance; use the injected clock and TTL (default six hours), cache both update and no-update results, advance the check timestamp after failed refreshes so failures are also rate-limited, preserve the prior cached value on failure, and clear the single-flight slot when the attempt settles. Every `getStatus()` path must resolve rather than reject, and simultaneous cold or expired calls must receive the same in-flight result.

Export the production adapter at the declared fetch seam:

```ts
export function fetchLatestVersionFromNpm(): Promise<string>;
```

It must GET `https://registry.npmjs.org/@pimote/pimote/latest`, validate the response and its string `version`, and reject malformed or unsuccessful responses for the checker to suppress. Keep `fetchLatestVersion` required in `UpdateCheckerOptions`: an explicit exported adapter keeps registry URL/response knowledge in this module, while avoiding both a hidden live-network default in tests and an inline fetch in `index.ts`.

**Verify:** `npm run build:shared`, `npm run test --workspace=@pimote/server -- --run src/update-check.test.ts`, `npx tsc --noEmit -p server/tsconfig.json`, and `npm ls semver --depth=0 --all` pass/show the intended direct runtime dependencies.
**Status:** done

### Step 2: Wire configuration and startup composition

In `server/src/config.ts`, include `updateCheck` in `loadConfig()` only when the JSON value is boolean, preserving explicit `true` and `false` while leaving an absent/invalid value undefined so the default remains enabled.

In `server/src/index.ts`, import `getVersion()` from `server/src/cli.ts` plus `createUpdateChecker()` and `fetchLatestVersionFromNpm()` from the update-check module. At the one enablement branch (`config.updateCheck !== false`), read the installed version, construct one process-lifetime checker with the real adapter, start a non-awaited `getStatus()` to warm that same checker's cache, and log the resolved nullable outcome without turning `null` into an error. Pass that checker as the final optional argument to `createServer`; when disabled, pass `undefined` and do not construct, warm, or invoke the registry adapter. Starting the warm-up before server construction lets an immediate connection share the same in-flight request.

Mechanically adapt the pre-existing exact-argument fixture in `server/src/index.test.ts`: mock `getVersion` and the update-check module's adapter/factory with a fake checker whose `getStatus()` resolves `null`, reset those mocks with the existing collaborators, and add that fake checker as the ninth expected `createServer` argument. Do not add or alter behavioral assertions in this fixture.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/config-update-check.test.ts src/index.test.ts` passes, startup remains non-blocking, and inspection confirms the false branch has no call path to `fetchLatestVersionFromNpm()`.
**Status:** done

### Step 3: Deliver update status on accepted connections

In `server/src/server.ts`, rename the injected `_updateChecker` parameter to `updateChecker`. After the client-version mismatch early return and after the new `WsHandler` is registered with its socket listeners, fire-and-forget `updateChecker?.getStatus()`. For a non-null result, construct the typed `UpdateAvailableEvent` (`{ type: 'update_available', ...status }`) and send it through `handler.sendToClient()` so serialization and send-error handling stay behind the existing WebSocket interface. Do nothing for `null` or an absent checker; never await this work in the connection callback or add broadcast/timer lifecycle.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/server-update-check.test.ts src/server.test.ts` and `npx tsc --noEmit -p server/tsconfig.json` pass; the wiring test observes one checker call and the exact event after an accepted connection.
**Status:** done

### Step 4: Implement client persistence, reactive state, and event ingestion

In `client/src/lib/stores/persistence.ts`, promote `_KEY_DISMISSED_UPDATE_VERSION` to the used `pimote:dismissedUpdateVersion` constant and implement the two declared accessors with the file's established best-effort `localStorage` pattern: reads return the stored string or `null`, and reads/writes swallow storage exceptions.

In `client/src/lib/stores/update.svelte.ts`, replace the declarations with private rune-backed status and dismissed-version state initialized from persistence, plus readonly getters for the public contract:

```ts
get status(): UpdateStatus | null;
get showBanner(): boolean;
get showMarker(): boolean;
```

`handleEvent()` must copy the three server-provided status fields without retaining the event discriminator. `showBanner` compares the current latest version with the persisted dismissal; `showMarker` depends only on a status being present. `dismiss()` is a no-op without status and otherwise updates both reactive dismissal state and persistence for that latest version.

In `client/src/lib/stores/connection.svelte.ts`, import the singleton `updateStore` and add a server-level `update_available` branch adjacent to `version_mismatch`: pass the narrowed event to `updateStore.handleEvent()` and return before response/session-event routing.

**Verify:** `npm run build:shared`, `npm run test --workspace=client -- --run src/lib/stores/update-persistence.test.ts src/lib/stores/update.svelte.test.ts src/lib/stores/connection.svelte.test.ts`, and `npm run check --workspace=client` pass.
**Status:** done

### Step 5: Add the dismissible update banner

Create `client/src/lib/components/UpdateBanner.svelte` using the existing `NotificationBanner.svelte` border, spacing, typography, action, and dismiss-control conventions. Render only while `updateStore.showBanner` is true. Show both `status.currentVersion` and `status.latestVersion`, render the server-supplied `status.releaseUrl` as a safe external link (`target="_blank"` with `rel="noopener noreferrer"`), and call `updateStore.dismiss()` from an accessible dismiss button. Do not reconstruct the release URL in the client.

Import and render the component next to `NotificationBanner` at the top of `client/src/routes/+page.svelte`, outside the viewed-session branch so it also appears on the landing/folder screen.

**Verify:** `npm run check --workspace=client` and `npm run build --workspace=client` pass; with an ingested status the banner displays both versions and the supplied link, and its dismiss control removes only the banner.
**Status:** done

### Step 6: Add the persistent ambient markers

Update the three architecture-selected client surfaces, all driven directly by `updateStore.showMarker`/`status` so dismissal cannot hide them:

- In `client/src/routes/+layout.svelte`, import `updateStore`, place the existing session-settings trigger in a relative wrapper, and overlay a small non-interactive dot when an update exists, following the adjacent panel-button badge positioning. Keep the existing rule that this control—and therefore the dot—appears only while a session is open.
- In `client/src/lib/components/SessionSettingsDialog.svelte`, add a conditional server-global row showing the running version, available version, and safe external link to the supplied release URL.
- In `client/src/lib/components/StatusBar.svelte`, add the desktop twin of that version information as a compact conditional item, separated consistently from neighboring status items and linked to the supplied release URL.

Do not add update content to `MobileRuntimeStatus` or any Android source.

**Verify:** `npm run check --workspace=client` and `npm run build --workspace=client` pass; manually dismissing a visible banner leaves the settings dot and both detail surfaces present, while a later event for a new version raises the banner again.
**Status:** not started

### Step 7: Run full feature verification

Run the repository-wide formatting, lint, type-check, build, server-test, and client-test commands after all slices are integrated. Exercise an enabled server against a controlled newer-version response to confirm startup warming and an early connection share one registry request, the WebSocket handshake is not delayed, and the banner-to-ambient flow survives reload. Exercise `updateCheck: false` and confirm there is no npm request and no `update_available` event. Also confirm equal and registry-older versions produce no client status.

Because `semver` is needed by packed server output, run the package dry-run and confirm the root manifest declares it as a runtime dependency.

**Verify:** `npm run format:check`, `npm run lint`, `npm run check`, `npm run build`, `npm run test --workspace=@pimote/server -- --run`, `npm run test --workspace=client -- --run`, and `npm run pack:dry-run` all pass, followed by the enabled/disabled manual checks above.
**Status:** not started

### Known test gap

The immutable feature tests preserve `updateCheck: false` through config loading, but none drives that value through `main()` to prove the checker is not constructed or warmed, and none asserts the absent-checker connection path emits no event. Step 2 must still enforce the disabled path structurally; the review phase should decide whether to add explicit regression coverage rather than weakening any existing behavioral test.
