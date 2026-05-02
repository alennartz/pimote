# DR-019: Sessions and projects sync into ContactsContract; one PhoneAccount

## Status

Accepted

Supersedes [DR-018](DR-018-sessions-and-projects-as-telecom-phoneaccounts.md).

## Context

DR-018 chose to model each unarchived session and each project as a separate self-managed `PhoneAccount`, with `PhoneAccountHandle.id` encoding the target. The intuition was that PhoneAccounts are how the Android telephony stack exposes "things you can call" — they appear in the dialer, contacts list, Auto picker, recents, and Assistant voice intents.

That intuition was wrong. Manual testing immediately produced:

```
java.lang.IllegalArgumentException: Error, cannot register phone account
... because the limit, 10, has been reached
```

The Android docs explicitly state: **"Each package is limited to 10 PhoneAccount registrations."** Beyond the cap is a hard limitation, not a quota we can negotiate.

More fundamentally: `PhoneAccount` models a _calling service_, not a callee. A SIM card is one PhoneAccount. WhatsApp Voice is one PhoneAccount. Skype is one PhoneAccount. The contacts you call _through_ those services live in `ContactsContract`. The 10-cap is reasonable when read that way: how many distinct calling services can a single app reasonably register? Not many. Google never intended PhoneAccounts to model individual contacts.

The correct primitive for "things you can call" is `ContactsContract`, exactly as Skype, WhatsApp, Signal, and every other VoIP app uses it.

## Decision

**Register exactly one Pimote PhoneAccount; sync sessions and projects into the system contacts database under a Pimote `AccountManager.Account`; route dial intents back to the single PhoneAccount via a custom `pimote:` URI scheme.**

Concretely:

- **One PhoneAccount.** `PhoneAccountRegistrarImpl.start()` registers a single self-managed PhoneAccount with `handleId = "pimote-service"`, label "Pimote", and `setSupportedUriSchemes(["pimote"])`. There are no per-session/project PhoneAccounts.
- **AccountManager Account.** A stub `PimoteAccountAuthenticator` exposes a "Pimote" account type via the standard `AbstractAccountAuthenticator` + service binding pattern. The authenticator is a no-op (Pimote does not authenticate users — auth is handled at the network layer per DR-017). The Account exists solely to own contact rows in `ContactsContract`.
- **ContactsContract sync.** `ContactSyncRunner` observes `SessionRepository.projects` + `.sessions`, debounced 2 s, computes the desired contact set via `ContactsSync.computeDesiredContacts`, diffs against existing rows owned by the Pimote Account, and applies the diff via a `ContentProviderOperation` batch. Each contact has:
  - `RawContacts.SOURCE_ID` = `"session:<id>"` or `"project:<base64url(folderPath)>"` (stable cross-sync identifier).
  - One `StructuredName.DISPLAY_NAME` row with the user-visible label.
  - One `Phone.NUMBER` row with the Pimote dial URI: `"pimote:session:<id>"` or `"pimote:project:<base64url(folderPath)>"`.
  - Phone type `TYPE_OTHER`, label `"Pimote"`.
- **No `WRITE_CONTACTS` permission.** All ContentResolver operations carry `CALLER_IS_SYNCADAPTER=true` and target rows owned by the Pimote Account. The system trusts apps to mutate rows under their own Account without runtime permissions.
- **Dial routing.** Tapping a Pimote contact, or saying "Hey Google, call X," fires `placeCall("pimote:session:abc", ...)`. Telecom resolves the URI scheme to our single PhoneAccount and invokes `PimoteConnectionService.onCreateOutgoingConnection` with `request.address` = the dial URI. We parse the URI via `PhoneAccountRules.parseDialUri` to recover the `SessionTarget`. No `PhoneAccountHandle.id` lookup; no per-target registry.

The pure logic (sanitization, label disambiguation, source-id encoding, dial-URI parsing) lives in `PhoneAccountRules` and `ContactsSync` — separately unit-testable. The Android-side runner (`ContactSyncRunner`) does only the platform integration (AccountManager, ContentResolver batches).

Rejected alternatives:

- **Stay on per-session PhoneAccounts and live with the 10-cap.** Bounded the registered set at 9 with a "register projects first, then sessions in input order" heuristic. Worked for verification but is fundamentally broken: any user with more than ~5 projects and a few sessions has invisible sessions in the system dialer/Auto/voice intents. Rejected as a permanent solution.
- **One generic Pimote PhoneAccount with in-app session disambiguation only.** Would have sidestepped the cap but lost "Hey Google, call pimote/X" voice routing and Auto's per-session contact entries. Defeats the original DR-018 use case.
- **Direct ContactsContract writes with `WRITE_CONTACTS` permission, no AccountManager Account.** Possible but worse: forces a runtime permission prompt, no automatic uninstall cleanup, contacts unaffiliated with any "Pimote" group in Settings → Accounts. Account-owned contacts is the platform-idiomatic pattern.
- **Full SyncAdapter (`AbstractThreadedSyncAdapter`).** Adds substantial boilerplate (separate sync service, sync_adapter.xml, sync triggers via `ContentResolver.requestSync`) for no v1 benefit — the app drives sync directly when SessionRepository emits, not on Android's sync framework cadence. May revisit if background sync becomes useful.

## Consequences

- **No cap on visible sessions/projects.** ContactsContract has no per-app contact-row limit. Users with hundreds of sessions/projects all appear in the system contacts list, dialer search, Auto contact picker, and voice intents.
- **One PhoneAccount registration, called once.** `PhoneAccountRegistrar` collapses to ~30 lines. The previous reconciliation logic, debounce, label-change replacement, and `MAX_REGISTERED_ACCOUNTS` cap are all gone.
- **Visible "Pimote" Account in Settings → Accounts.** Users can disable / remove the account, which removes all synced Pimote contacts. App uninstall removes the Account, which removes the contacts. This is the standard cleanup path for Android apps that own contacts.
- **`PimoteConnectionService.onCreateOutgoingConnection` parses the URI directly.** No `AccountKind` registry, no `resolve(handleId)` indirection. The URI carries everything needed.
- **`pimote:` URI scheme is fully owned by us.** No collision risk with `tel:`, `sip:`, etc. Telecom's URI-scheme routing handles dispatch.
- **Custom in-call actions for Auto remain deferred** (carried over from DR-018's consequences). Standard `CAPABILITY_MUTE | CAPABILITY_SUPPORT_HOLD` only in v1.
- **OEM Bluetooth/Auto routing quirks risk remains** (carried over from DR-018). Stock Android (Pixel) is the verified target.
- **No `WRITE_CONTACTS` / `READ_CONTACTS` permissions** in the manifest. The CALLER_IS_SYNCADAPTER + own-Account pattern is the right way and avoids prompting users.
- **Tests:** `PhoneAccountRegistrarImplTest` deleted (the entity it tested is now ~30 lines of trivial wiring); `ContactsSyncTest` added covering the diff and desired-set derivation; `PhoneAccountRulesTest` updated to drop the obsolete `computeDesiredAccounts` / `diff` tests and add `parseDialUri` tests. The pure logic moved cleanly across the architectural boundary.
