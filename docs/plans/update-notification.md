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
