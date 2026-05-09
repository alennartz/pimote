# Android — Assistant-callable Pimote projects

## The idea

Pimote registers project entries as system contacts, but Google Assistant's
"call &lt;project&gt;" voice intent doesn't resolve them, and the system
contact card shows no per-MIME action button when one is tapped. DR-024
claimed this would work via a custom-MIME `<ContactsDataKind>` and
`CONTACTS_STRUCTURE` resource alone. That claim turned out to be wrong on
two counts (verified against AOSP source and Android Developers docs):

1. The contact-card action button is built by the Contacts app resolving
   `Intent(ACTION_VIEW).setDataAndType(rowUri, mimeType)` against installed
   activities. With no activity declaring an `<intent-filter>` for that
   action+MIME, no button renders. The CONTACTS_STRUCTURE XML only describes
   _how_ to render the data row, not what action to attach.
2. Google Assistant's "call &lt;name&gt;" voice resolver does not search
   `ContactsContract` for custom-MIME callable rows. For regular contacts it
   uses a privileged path that searches `Phone` data rows directly and
   dispatches `tel:` URIs through Telecom's default outgoing-call account
   (the SIM). Third-party calling apps don't share that path unless they
   claim `tel:` globally — which forces a chooser on every SIM call.

The right SDK split for a third-party calling app like Pimote is three
independent layers:

| Concern                                                               | SDK                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Place/receive the call (audio, lifecycle, in-call UI)                 | `TelecomManager` + self-managed `ConnectionService` + `PhoneAccount`            |
| Resolve voice utterance → app intent                                  | App Actions (`shortcuts.xml` capability + dynamic shortcuts)                    |
| Surface the entity in Contacts list, contact card, dialer name-search | `ContactsContract` (custom MIME) + per-MIME `<intent-filter>` for `ACTION_VIEW` |

The first layer already exists. The second and third are the work this
brainstorm scopes.

## Scope

In:

- **Voice intent.** "Hey Google, call &lt;project&gt;" / "call repos
  &lt;project&gt;" routes to our PhoneAccount via App Actions.
- **Contact card action button.** Tapping a Pimote contact in the system
  Contacts app shows a "Pimote" call action that initiates the call.
- **Dialer name search.** Typing a project name in the Phone app's search
  surfaces the Pimote contact and tapping it initiates the call. (Falls out
  of the contact-card action button for free.)

Out:

- **Assistant / Google Home Routines "Call" picker.** That picker enumerates
  only `tel:` `Phone` rows. Getting in requires either claiming `tel:`
  globally (chooser-on-every-SIM-call UX cost — explicitly rejected) or
  becoming a default dialer / call-redirection service (architecturally
  invasive, single-app-at-a-time system role — also rejected). No clean
  third-party path exists.
- **Uncapped voice resolution.** App Actions caps dynamic shortcuts at
  `ShortcutManager.getMaxShortcutCountPerActivity()` (typically 15). The
  uncapped alternative is the same `tel:` claim as Routines. Rejected for
  the same reason.

## Key decisions

### Voice classifier = root segment, not a "Pimote" prefix

- **Why:** STT mishears the brand name "Pimote" (user pronounces "pie-mote";
  STT hears "pee-mote"); root segment names ("repos", "work",
  "experiments") are common dictionary words that STT handles reliably and
  rarely collide with human contact names. The classifier also maps to the
  grouping users already have in their head and gives natural
  disambiguation when the same project name exists under multiple roots.
- **Derived client-side:** `rootSegment =
parentDir(folderPath).substringAfterLast('/')`. No protocol change.

### Visible classifier in contact display name

- **Why:** aligns dialer name-search and contact-list grouping with the
  voice utterance pattern. Eliminates the voice-vs-screen asymmetry where
  the user says "repos pimote" but sees just "pimote" on screen.
- Replaces the current `PhoneAccountRules.disambiguateFolderLabels` logic
  for collision handling — root-prefixed names disambiguate inherently.
- Format: `<root> <project>` (exact separator/capitalization deferred to
  architect phase).

### Voice via App Actions, top 15 by recency

- **Why:** App Actions is the only sanctioned public-API path for
  voice-resolving a non-`tel:` calling target. The cap is a system limit,
  not a choice. Most-recent ranking matches typical user behavior —
  recently-touched projects are likely upcoming voice targets.
- One slot reserved for a generic `"Pimote"` / `"my pi"` fallback shortcut
  that routes to the most-recently-active project; covers "I just want to
  talk to my pi" without naming one. Pronunciation variants ("pee mote",
  "pie mote") encoded as parameter synonyms.
- Long-tail (16+) projects: remain visible in Contacts, callable via dialer
  search and contact-card tap, just not voice. Graceful degradation.
- Re-rank on every project list change.

### Contact card button via ACTION_VIEW intent filter

- **Why:** matches AOSP's `DataKind.java` action-construction model. The
  Contacts app builds the per-MIME button by resolving
  `Intent(ACTION_VIEW).setDataAndType(rowUri, mimeType)` against the
  package — without a matching activity, no button.
- Trampoline activity reads `intent.data` (the Data row URI), queries
  ContactsContract for the row's `data1` (the `pimote:` URI), invokes
  `TelecomManager.placeCall`, finishes. Reusable as the fulfillment activity
  for the App Actions capability if the parameter contract permits.

### ContactsContract sync stays largely as-is

- Custom MIME row, projects-only, SyncAdapter shim, `Settings.UNGROUPED_VISIBLE`
  row — all retained from DR-024's structural choices. Those were correct.
- The narrative DR-024 attached to that structure (custom MIME being how
  Assistant discovers callable contacts) is wrong and will be corrected via
  a successor decision record at cleanup time.

## Direction

Three-pronged implementation:

1. **App Actions / voice surface (new).**
   - `res/xml/shortcuts.xml` declaring `<capability android:name="actions.intent.CREATE_CALL">` whose intent targets a `PimoteCallFulfillmentActivity` with `call.participant.name` mapped to an extra.
   - `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />` on `MainActivity`.
   - `ShortcutsRepository` driven by `SessionRepository.projects` + last-activity timestamps. Pushes top 14 projects by recency as long-lived dynamic shortcuts via `ShortcutManagerCompat.pushDynamicShortcut`, each with `addCapabilityBinding("actions.intent.CREATE_CALL", "call.participant.name", listOfSynonyms)`. Plus 1 generic fallback shortcut. Re-syncs on project list change.
   - `PimoteCallFulfillmentActivity` resolves the parameter to a project (with runtime fuzzy match as defensive fallback for utterances that didn't hit a shortcut exactly) and delegates to the existing Telecom path.

2. **Contact card / dialer surface (new).**
   - `<intent-filter>` for `ACTION_VIEW` + `mimeType="vnd.android.cursor.item/vnd.com.pimote.android.call"` on a trampoline activity (likely the same fulfillment activity). Activity reads the Data row URI, fetches `data1`, triggers Telecom call.

3. **Existing ContactsContract sync (touch-up).**
   - Update `ContactsSync.computeDesiredContacts` so display name is `<root> <project>` instead of bare project name with collision-driven disambiguation. Drop or simplify `PhoneAccountRules.disambiguateFolderLabels` accordingly.
   - No other changes to the sync runner.

## Open questions

- **Cross-OEM behavior of the 15-shortcut cap.** Some OEMs and Android
  versions have a larger pool for long-lived or capability-bound shortcuts.
  We assume 15 conservatively but should measure on the test device(s) —
  the architect/impl phase can decide whether to push slightly more.
- **Defensive runtime fuzzy match.** Whether Assistant ever hands the
  fulfillment activity a parameter value that didn't match any shortcut
  (i.e. open pass-through) for `call.participant.name` is undocumented in
  practice. We'll implement a runtime best-match against the full project
  list as a safety net regardless, but its hit rate is unknown until tested.
- **Display-name change on existing installs.** Renaming visible contacts
  on devices that already have Pimote contacts synced will trigger a one-
  time rewrite via the existing diff logic. Should be benign, but worth
  watching during manual test for transient odd states.
- **Successor decision record.** DR-024 needs to be amended or superseded
  to correct the Assistant-discovery narrative; defer to cleanup.
