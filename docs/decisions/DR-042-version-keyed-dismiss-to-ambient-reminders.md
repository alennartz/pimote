# DR-042: Dismiss update notices into version-keyed ambient reminders

## Status

Accepted

## Context

The notice is seen on a phone but acted on later at a terminal: it is a note to
the operator's future self, not an alert that can be resolved immediately. A
reminder that disappears on dismissal therefore loses the feature's value, but
a permanent interruption is a poor fit for a small mobile viewport.

Several kinds of dismissal were considered. Sticky-until-updated would make a
banner a permanent fixture. A boolean dismissal would silence every future
release forever. Connection-scoped dismissal would reset during the constant
mobile reconnects and make it useless. A permanent `MobileRuntimeStatus` chip
would violate that strip's error-only purpose and always cost a row of phone
height.

## Decision

Show one interrupting banner for the currently available version. Dismissing
it stores that exact latest-version string in local storage, hides only the
banner, and leaves an ambient reminder: a dot on the session settings gear and
a detail row in `SessionSettingsDialog` on mobile, plus a compact `StatusBar`
item on desktop. The ambient surfaces depend only on update status, not on the
dismissed value. When a later event carries a different latest version, the
banner becomes eligible again automatically.

The server-provided release URL and version fields are rendered as supplied;
the client does not reconstruct release links. Android receives no update UI;
its existing protocol reader safely skips unknown event types.

## Consequences

- Dismissal survives reloads and reconnects, while each new release earns one
  interruption without turning the reminder into permanent modal chrome.
- The reminder remains revisitable after dismissal, but local storage is
  device-local and best-effort; storage failure cannot prevent the current
  session from displaying its status.
- The settings gear exists only while a session is open, so the sessionless
  landing/folder screen has no ambient marker and relies on the banner. This is
  an accepted trade for introducing no new persistent landing-screen chrome.
- The error-only runtime-status strip stays unchanged, and the Android client
  remains free of update-specific surfaces while safely ignoring the event.
