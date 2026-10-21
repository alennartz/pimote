---
description: Build the Android debug APK and publish it to a configured rclone destination
---

Build and publish the Pimote native Android debug APK. Do not trust an
existing APK on disk — always rebuild before publishing so the upload
reflects the current working tree.

## Phase 1 — Rebuild the APK

Run the containerized Gradle build from the repo root:

```bash
make android-build
```

Expected output path:

```
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

If the build fails, stop and report the failure. Do not publish a stale APK.

## Phase 2 — Publish to Google Drive

Set `PIMOTE_ANDROID_RCLONE_DESTINATION` to the rclone destination for the published artifact before uploading.

**Naming convention** (verified from existing entries):

```
app-debug-YYYY-MM-DD-HHMM-<short-sha>.apk
```

- `YYYY-MM-DD-HHMM` — local time at publish (zero-padded, 24h)
- `<short-sha>` — 7-char git short SHA of `HEAD` in `pimote/`

Compute the name and upload:

```bash
STAMP=$(date +%Y-%m-%d-%H%M)
REPO_ROOT=$(git rev-parse --show-toplevel)
SHA=$(git rev-parse --short=7 HEAD)
NAME="app-debug-${STAMP}-${SHA}.apk"
DESTINATION="${PIMOTE_ANDROID_RCLONE_DESTINATION:?Set PIMOTE_ANDROID_RCLONE_DESTINATION first}"
rclone copyto \
  "$REPO_ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk" \
  "${DESTINATION}/${NAME}" \
  --progress
```

Then verify the upload landed:

```bash
rclone ls "$PIMOTE_ANDROID_RCLONE_DESTINATION" | head
```

Report the final published filename to the user.
