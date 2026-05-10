# Bug: Pimote contact-card action button not rendered on Google Contacts

**Surface:** Android client — system Contacts app (Google Contacts, Play-distributed)
**First observed device:** Pixel 8, Android 16 build CP1A.260405.005, Google Contacts stock
**Severity:** Functional — one of the three intended surfaces for project calling does not work in practice; voice and dialer name-search still function so the topic ships, but the contact-card surface is dead on this device.
**Related decisions:** DR-025 (the surface is documented as known-non-working there)

## Summary

Opening a Pimote project contact in Google Contacts shows the contact name in `<root> <project>` format and "Contact created by Pimote" attribution, but no callable per-MIME action button is rendered. The four standard buttons (Call / Message / Video / Email) are greyed out (no `Phone` / `Email` rows exist), and the body shows "No contact details". Visible state is indistinguishable from the pre-`android-assistant-callable-projects` topic — the user's original complaint that prompted the work.

## What was verified to be correct under the hood

- The custom-MIME data row is present and well-formed. `content query --uri content://com.android.contacts/data` returns row id 10059 with `mimetype=vnd.android.cursor.item/vnd.com.pimote.android.call`, `data1=pimote:project:...`, `data2=Pimote`, `data3=Call repos pimote`.
- The `CONTACTS_STRUCTURE` resource is declared on `PimoteAuthenticatorService` and points at the correct `<ContactsDataKind>` for the callable MIME.
- The `<intent-filter>` for `ACTION_VIEW` + the custom MIME on `CallByDataRowActivity` resolves correctly: `pm query-activities -a android.intent.action.VIEW -t vnd.android.cursor.item/vnd.com.pimote.android.call` returns `CallByDataRowActivity` as a default-resolved match.
- Manually firing the intent dispatches the trampoline end-to-end: `am start -a android.intent.action.VIEW -d content://com.android.contacts/data/10059 -t vnd.android.cursor.item/vnd.com.pimote.android.call` launches `CallByDataRowActivity`, which reads `data1`, calls `CallByPimoteUri.placeCall`, and a real Telecom-routed call goes through (`state -> Active`, `InCallActivity` opens).

The wiring is correct against the documented AOSP `DataKind.java` contract (`Intent(ACTION_VIEW).setDataAndType(rowUri, mimeType)` resolved against installed activities to render an action). Google Contacts on this device just doesn't follow that contract for our row.

## Repro

1. Build and install the Android app at HEAD (or any commit on/after `8c4b80a`).
2. Grant `READ_CONTACTS` / `WRITE_CONTACTS`; wait ~2 s for `ContactSyncRunner` to flush.
3. Open the system Contacts app (Google Contacts).
4. Open any synced Pimote project contact (e.g. `repos pimote`).
5. **Expected:** a "Pimote" / "Call" action button is present on the card alongside the contact name.
6. **Actual:** no per-MIME action button; the standard Call/Message/Video/Email buttons are greyed out; body shows "No contact details".

## Most likely architectural cause

Google Contacts (Play-distributed, separate codebase from AOSP Contacts) appears to not follow the AOSP `DataKind` card-building path for custom MIMEs in practice. Hypotheses worth probing:

- Google Contacts may gate per-MIME action rendering on the contact also having a standard `Phone` (or `Email`) row.
- It may ignore custom MIMEs entirely on the card surface and only render them in a different surface (the contact picker? a sharesheet?).
- It may require additional metadata in `CONTACTS_STRUCTURE` that the AOSP source doesn't require (e.g. specific summary/detail column types or an icon at a particular resolution).
- The behavior may differ across Google Contacts versions or be A/B-flagged.

None of this is publicly documented. Confirming any hypothesis requires empirical probing of supported row variations on real devices, or reverse-engineering Google Contacts.

## Suggested investigation paths

1. **Synthetic `Phone` row alongside the custom-MIME row.** Add a non-`tel:` placeholder `Phone` row to each Pimote contact and see whether the per-MIME action then surfaces. Risk: the standard `Call` button might activate and try to dial nonsense; need to guard against accidental SIM dispatch.
2. **Test on AOSP Contacts.** Sideload AOSP Contacts (or test on a device that ships it) to confirm the AOSP `DataKind` path renders the button as documented. This isolates whether the issue is Google Contacts behavior or a flaw in our wiring.
3. **Test on other contact apps.** Some OEM contacts apps (Samsung Contacts, etc.) may still follow the AOSP contract. A working result on any of them would confirm our wiring is correct and isolate the issue to Google Contacts specifically.
4. **Drop the contact-card surface from scope.** If reverse-engineering Google Contacts proves intractable, accept that voice (working) and dialer name-search (working) are the user-facing surfaces, and replace the card-button intent with something else (launcher-pinned shortcut, home-screen widget, in-app contact list with a tap-to-call). The ContactsContract sync stays — it powers dialer search regardless.

## Cost / urgency

Voice and dialer name-search cover the primary use case. The contact-card button is a redundant convenience surface; long-tail projects (beyond the App Actions ~15-shortcut cap) are still callable from the dialer. No blocker for shipping `android-assistant-callable-projects`. Worth picking up when there's a stretch of bandwidth for a focused Android exploration session on real devices.

## Code in place that this bug doesn't invalidate

`CallByDataRowActivity` and its `<intent-filter>` remain useful and correct — they're the right wiring for the surface in principle, and they work when invoked manually. If a future Google Contacts version (or any other contacts app) starts honoring the AOSP contract, the surface will start working with no client-side changes. Leave the activity in place.
