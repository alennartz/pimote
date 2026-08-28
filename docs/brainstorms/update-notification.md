# Update Notification

## The Idea

Tell a self-hosted pimote user when a newer `@pimote/pimote` has been published to npm.

Scope was cut during the brainstorm to **notification only**. A one-click self-update was
considered and deferred: the hard part is not running `npm i -g`, it is the restart. The
systemd unit ships `Restart=on-failure` (`scripts/install-systemd-service.mjs:31`), so a clean
exit would not come back, and hand-launched installs have no supervisor at all — a failed
self-update locks the user out of the remote access the product exists to provide. Cutting the
update half also shrinks the blast radius of a wrong registry answer down to "wrong banner",
which is what makes the cheaper design choices below defensible.

## Key Decisions

### Surface: the PWA, not the terminal

First instinct was terminal-first — print on `pimote start`, where the person can act
immediately. Rejected: pimote is a single-user tool, so the person looking at the phone _is_
the person who can run the update, just not at that moment. The PWA is the interface; putting
the notice anywhere else means it is never seen.

The consequence shapes everything downstream: this is **a note you leave for your future self
at the terminal**, not an alert to act on. The gap between seeing it and acting on it may be days.

### Lifecycle: dismiss to ambient

Because the user cannot act when they see it, throwing the reminder away on dismiss is the
central failure mode. Three options were weighed:

- Sticky until updated — honest, but a permanent fixture in a small mobile viewport.
- Dismiss per version — hides until the next release; loses the reminder exactly when it was
  still needed.
- **Dismiss to ambient** — the banner collapses into a low-key persistent marker.

Chosen: dismiss to ambient. It is the only option that keeps the reminder while dropping the
interruption. An intermediate idea — "dismiss until the next app session" — was discarded once
we pinned down what "session" meant: an installed PWA is rarely cold-started, and keying off
the WebSocket connection is worse still, since the mobile workflow reconnects constantly.

### Ambient marker: settings gear dot + settings dialog row

- Mobile: a dot on the existing settings gear (`client/src/routes/+layout.svelte:297`), with the
  detail as a row inside `SessionSettingsDialog`. The dot-badge-on-an-icon pattern already exists
  next to it on the panel button (`+layout.svelte:288`), and `StatusBar.svelte:1` documents the
  convention: _"Mobile shows these stats in SessionSettingsDialog."_
- Desktop: a small item in `StatusBar`.

Explicitly **not** `MobileRuntimeStatus`. That chip strip only renders when something is wrong;
a permanent version chip would make it always-on, costing a row of vertical phone height forever.

Accepted consequence: the gear renders only when a session is open, so the landing/folder screen
has no ambient marker — only the banner. The landing screen is transient, so this is fine.

No new persistent chrome is introduced anywhere. The banner is the only genuinely new surface.

### The server polls the registry, not the client

A client-side fetch is viable — `registry.npmjs.org` is CORS-enabled, and the PWA ships **no
CSP** (`server/src/static-host/http-handler.ts:170` sets one only for agent-hosted bundles, to
contain prompt-injected content), so nothing would need loosening. The threat model is also thin:
an XSS-driven outbound path to npm is a write-only channel to someone else's logs, and a MITM'd
or hostile registry answer yields only a wrong banner now that self-update is cut.

Server-side was chosen on **architectural** grounds instead: today the PWA talks only to your own
server. That property makes air-gapped and tunnel-only deployments behave identically to public
ones, and gives "does pimote phone home?" a one-word answer. It is worth more than the ~20 lines
a client-side fetch would save. Server-side also keeps the comparison next to the truth — the
server knows its own installed version (`server/src/cli.ts:29`) rather than reasoning about a
number it was handed — which matches how `version_mismatch` already works, and costs one check
per host rather than one per device.

### Opt-out flag on the server

An air-gapped or privacy-sensitive install must be able to silence the check. Because the call
lives in one place, so does the switch.

### Notify on every version

19 releases in ~5 months — roughly one every 8 days — and all `0.x`, so "minor" is the feature
release. Severity gating would filter almost nothing while adding a rule to reason about.

### Link to the GitHub release tag; no inline notes

"0.12.0 is available" gives the user nothing to weigh a later trip to the terminal against, so
the rational response is to ignore it. A link to
`github.com/alennartz/pimote/releases/tag/pimote-v<version>` is a string template constructible
from the version alone — no extra fetch, no rate-limited GitHub API. Release notes are not
currently written; the tag page still renders the commit list, so the link degrades gracefully
and creates a mild incentive to start writing them. Pulling release bodies inline was rejected
as real work for a paragraph the user could tap through to.

### The loop closes itself

After the user updates and the server restarts on the new version, the existing `version_mismatch`
path (`server/src/server.ts:216`) forces a client reload. The banner and ambient marker clear with
no extra mechanism.

### Supporting context

pimote bundles pi as a dependency (`@earendil-works/pi-coding-agent`), so a new pi release reaches
the user only through a new pimote release. The notice therefore signals "your pi is stale" as much
as "your pimote is stale", which raises the value of the feature.

Off-the-shelf options were surveyed: `latest-version` + `semver` is the right fit.
`update-notifier` was rejected despite being the well-known choice — it is built for short-lived
CLIs, populating its result from the _previous_ run's cache via a detached background check, which
is backwards for a daemon that restarts rarely, and it wants to print to stderr rather than yield
structured data.

## Direction

The server checks the npm registry for `@pimote/pimote` on a cadence, compares against its own
installed version, and pushes an update-available signal to connected clients. The PWA shows a
banner; dismissing it collapses the notice into a dot on the settings gear (mobile) or a
`StatusBar` item (desktop), with detail — running version, available version, and a link to the
GitHub release tag — in `SessionSettingsDialog`. A server flag disables the check entirely.

## Open Questions

### Sharp — inputs to architecting

- Poll cadence, and behaviour on registry failure or no network (silent failure assumed, but
  retry/backoff policy is undecided).
- Whether the check also runs at startup and logs its result to the console.
- Shape of the protocol event, and whether the running version is reported on connect
  independently of the check.
- Where dismissal state lives (localStorage key, keyed by version) and how it interacts with the
  ambient marker's visibility.
- Name and mechanism of the opt-out (CLI flag, env var, or both).

### Fog

- The Android client (`mobile/android/`) gets nothing from this.
- Whether pi-version staleness deserves a signal of its own, given pimote bundles pi.
- Whether `@pimote/panels` versioning is relevant here at all.
