# DR-025: Voice via App Actions; ContactsContract as supporting-surface only

## Status

Accepted

Supersedes DR-024 (Pimote contacts as Assistant-discoverable callable-MIME rows), deleted at commit `d26167d1fdf974cefb6162e3be6f33f59a4704d7`.

## Context

DR-024 claimed two affordances would fall out of a custom-MIME `ContactsDataKind` plus a `CONTACTS_STRUCTURE` resource on the Pimote AccountAuthenticator:

1. **Google Assistant "call &lt;project&gt;" voice resolution** would hit the row's `pimote:` URI and route through Telecom.
2. **The system contact card** would render a per-MIME "Pimote" call action button on each Pimote contact.

Verified against AOSP source, Android Developers docs, and a Pixel 8 / Android 16 device, both claims were wrong:

1. Google Assistant's "call &lt;name&gt;" voice resolver does **not** search `ContactsContract` for custom-MIME rows. The privileged path it uses for native contacts inspects `Phone` data rows with `tel:` URIs and dispatches through Telecom's default outgoing-call account (the SIM). Third-party calling apps don't share that path unless they claim `tel:` globally — which would force a chooser on every SIM call (architecturally rejected in the brainstorm). The sanctioned third-party voice path is App Actions: a `shortcuts.xml` capability declaration plus dynamic shortcuts bound to it via `addCapabilityBinding`.
2. The AOSP `DataKind.java` model — `Intent(ACTION_VIEW).setDataAndType(rowUri, mimeType)` resolved against installed activities to render a per-MIME action — is the documented contract, but Google Contacts (Play-distributed, separate from AOSP Contacts) on Pixel 8 / Android 16 does not appear to follow it for custom MIMEs in practice. With the trampoline activity declared, its `<intent-filter>` resolving via `pm query-activities`, and `am start` dispatching `CallByDataRowActivity` end-to-end into a real Telecom call, the contact card still shows no per-MIME action. The card surface itself just doesn't render the button. This is observable empirically; the underlying cause (Google Contacts ignoring custom MIMEs, gating on a `Phone` row, only rendering on different surfaces, etc.) is not publicly documented.

The structural choices DR-024 inherited from DR-019 — single self-managed PhoneAccount, `pimote:` URI-scheme dispatch, AccountManager Account ownership of contact rows, projects-only sync, no-op SyncAdapter shim, `Settings.UNGROUPED_VISIBLE` row, runtime `READ_CONTACTS` / `WRITE_CONTACTS` permissions — all held up. What did not hold up is the narrative DR-024 attached to that structure: that the ContactsContract row representation is the discovery mechanism for both voice and the contact card.

## Decision

**Voice goes through App Actions; ContactsContract sync remains as a supporting-visibility surface only.** The three concerns are decoupled into independent SDKs, each addressed by the layer that actually owns it on modern Android:

| Concern                                                      | SDK                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Place / receive the call (audio, lifecycle, in-call UI)      | `TelecomManager` + self-managed `ConnectionService` + `PhoneAccount`            |
| Resolve voice utterance → app intent                         | App Actions (`shortcuts.xml` capability + dynamic shortcuts)                    |
| Surface entity in Contacts list, dialer search, contact card | `ContactsContract` (custom MIME) + per-MIME `<intent-filter>` for `ACTION_VIEW` |

The first layer was already in place from DR-019/DR-024. The third is what DR-024 actually built. The second is new in this decision.

Concretely:

- **Voice via App Actions.** A new `shortcuts/` module owns the voice surface. `res/xml/shortcuts.xml` declares an `actions.intent.CREATE_CALL` capability whose intent targets `CallByNameActivity` with the `call.participant.name` parameter mapped to a `participantName` extra. A `ShortcutsRunner` observes `SessionRepository`, debounces (2 s, mirroring `ContactSyncRunner`), and reconciles the dynamic-shortcut set via `ShortcutManagerCompat`. The desired set is one fallback shortcut at rank 0 ("Pimote", with synonyms `[Pimote, pee mote, pee-mote, pie mote, pie-mote, my pi]`) plus up to `ShortcutManagerCompat.getMaxShortcutCountPerActivity() − 1` project shortcuts (typically 14) by recency. Each project shortcut binds `addCapabilityBinding("actions.intent.CREATE_CALL", "call.participant.name", synonyms)` with synonyms `[<project>, <root> <project>]`.
- **`CallByNameActivity` resolves the `participantName` extra** via: (a) fallback path when the value is empty, equals `FALLBACK_PARAMETER`, or matches a `FALLBACK_SYNONYMS` entry case-insensitively — resolves to the most-recently-active project; (b) exact match against any known shortcut's `capabilityParameter` _or_ `synonyms` list; (c) `ShortcutsSync.resolveByFuzzyMatch` over the full project list (token-overlap scorer with a `>= 0.5` cutoff and a length-3 shared-token floor); (d) defensive `MainActivity` launch. On match it dispatches through `CallByPimoteUri.placeCall`, which builds the Pimote-scoped `PhoneAccountHandle` and calls `TelecomManager.placeCall(pimote:..., EXTRA_PHONE_ACCOUNT_HANDLE)`.
- **Display name = `<root> <project>`.** `ContactsSync.computeDesiredContacts` builds the contact display name from `PhoneAccountRules.rootSegmentOf(folderPath)` + project basename (e.g. `repos pimote`), falling back to the bare basename when the parent has no segment. This replaces DR-024's collision-driven `disambiguateFolderLabels`-based naming. The format aligns dialer name search and Assistant utterance recognition: the user says "repos pimote" and sees "repos pimote" everywhere. The `disambiguateFolderLabels` helper is retained for the in-app `ContactsScreen` short-label use case but no longer called from `ContactsSync`.
- **ContactsContract sync from DR-024 carries forward unchanged structurally** (custom MIME `vnd.android.cursor.item/vnd.com.pimote.android.call`, `CONTACTS_STRUCTURE` resource, no-op SyncAdapter shim, `Settings.UNGROUPED_VISIBLE` row, projects-only, runtime contacts permissions). Its role is now narrower: it makes Pimote contacts visible in the Contacts list and findable by dialer name search. It does **not** drive voice resolution (App Actions does) and, on Pixel 8 / Android 16 with stock Google Contacts, it does **not** in practice render a contact-card action button.
- **`CallByDataRowActivity` ships anyway.** A trampoline activity declaring an `<intent-filter>` for `ACTION_VIEW` on the custom MIME exists and is wired correctly (verified end-to-end via `am start`). The button doesn't render on the device tested, but the cost of carrying the wiring is trivial; if Google Contacts behavior changes, or if another contact-app surfaces the action (e.g. AOSP Contacts on a different device, a third-party contacts app), the path works. It's also the right surface for `ContactsContract`-driven dispatch in principle.

Rejected alternatives:

- **Stay with DR-024's claim and skip App Actions.** Empirically broken for voice — Assistant simply does not route "call &lt;project&gt;" through `ContactsContract` rows whose data is a non-`tel:` URI. Without App Actions there is no voice surface at all.
- **Claim `tel:` globally to ride the privileged voice path.** Forces a chooser on every SIM dial. Rejected at brainstorm time and not revisited.
- **Become a default dialer or call-redirection service.** Single-app-at-a-time system role and invasive integration; cost / benefit indefensible for a remote-control app.
- **Use App Actions only and drop the ContactsContract sync.** Loses the long-tail callability — App Actions caps voice at ~15 shortcuts, but a user with 50 projects still wants to find and call the off-cap ones via the dialer search. The ContactsContract surface delivers that, at the cost of one no-op SyncAdapter shim.
- **Invest in restoring the contact-card action button on Google Contacts.** Would require reverse-engineering Google Contacts behavior or empirically probing supported-row variations (synthetic `Phone` row, alternative MIMEs, different CONTACTS_STRUCTURE shapes) with no public documentation to anchor the work. Deferred to a follow-up bug; the dialer-search + voice surfaces already cover the primary use cases.

## Consequences

- **Voice works in practice.** Verified on Pixel 8 / Android 16: "Hey Google, call Pimote" resolves the fallback shortcut → most-recently-active project; "Hey Google, call &lt;project&gt;" (or "call &lt;root&gt; &lt;project&gt;") resolves directly via the bound synonyms; mispronunciations fall through to fuzzy match. This is the user-facing surface DR-024 was trying to deliver and ultimately did not.
- **Dialer name search works.** Typing "repos pim" in the system Phone app surfaces the Pimote contact for `/repos/pimote` and dispatches the `pimote:` URI on tap. This is the long-tail (>14 projects) surface for projects that don't fit in the voice cap.
- **Contact-card action button does not work today on stock Google Contacts (Pixel 8 / Android 16).** User-visible: the card shows the contact name and "Contact created by Pimote" attribution but no callable action; the standard Call/Message/Video/Email buttons are greyed out because no `Phone` row exists. Indistinguishable to the user from the pre-DR-024 state for this specific surface. Tracked as a follow-up bug; not blocking voice or dialer-search functionality. `CallByDataRowActivity` remains in the codebase as the correct wiring for the surface, ready for whatever resolution the bug investigation produces.
- **Two trampoline activities, both intentional.** `CallByNameActivity` (App Actions fulfillment, no intent filter, launched by Assistant) and `CallByDataRowActivity` (contact-card ACTION_VIEW, declares the custom-MIME intent filter). Their contracts are different enough — string extras vs Data row URI — that unifying them would force runtime intent-shape branching. Two ~30-line activities delegating to a shared `CallByPimoteUri.placeCall` helper is the cleaner shape.
- **Shortcut cap is an accepted system limit.** Long-tail projects (>14) are voice-uncallable by name. The fallback synonym ("call Pimote") still works for them via the most-recently-active resolver. The dialer-search surface backs them up. The uncapped alternative is the same `tel:` global claim already rejected.
- **One more cross-component contract.** The shortcut capability name `actions.intent.CREATE_CALL` and parameter name `call.participant.name` are now coupled across `shortcuts.xml`, `AndroidShortcutManagerFacade.setDynamicShortcuts` (via `addCapabilityBinding`), and `CallByNameActivity.onCreate` (which reads the `participantName` extra mapped by the parameter binding). Drift would silently break voice fulfillment.
- **Cold-process Telecom dispatch is now the common case, not the rare case.** Both new entry points (`CallByNameActivity`, `CallByDataRowActivity`) can launch a Pimote outgoing call without the app ever being foregrounded first, which means `CallControllerImpl.runOutgoing` regularly runs before the WS has reconnected. A pre-existing race in `CallController.kt:326` (sending the WS request before `WsClient` is connected) becomes a frequent crash rather than a rare one. Tracked as a separate follow-up bug.
- **DR-019 → DR-024 → DR-025 lineage.** DR-019's `Phone.NUMBER` row representation and "no contacts permissions / no SyncAdapter" claims were already reversed by DR-024 and remain reversed. DR-024's narrative ("custom MIME + CONTACTS_STRUCTURE = voice + card button") is what this DR corrects. The ContactsContract structural code DR-024 produced is preserved as-is and continues to do useful work — just for a narrower purpose than DR-024 claimed.
