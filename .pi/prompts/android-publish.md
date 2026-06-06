---
description: Build the Android debug APK and publish it to gdrive:pimote-builds
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

The published artifact lives in the `gdrive:pimote-builds/` rclone remote.

**Naming convention** (verified from existing entries):

```
app-debug-YYYY-MM-DD-HHMM-<short-sha>.apk
```

- `YYYY-MM-DD-HHMM` — local time at publish (zero-padded, 24h)
- `<short-sha>` — 7-char git short SHA of `HEAD` in `pimote/`

Compute the name and upload:

```bash
STAMP=$(date +%Y-%m-%d-%H%M)
SHA=$(git -C /home/alenna/repos/pimote rev-parse --short=7 HEAD)
NAME="app-debug-${STAMP}-${SHA}.apk"
rclone copyto \
  /home/alenna/repos/pimote/mobile/android/app/build/outputs/apk/debug/app-debug.apk \
  "gdrive:pimote-builds/${NAME}" \
  --progress
```

Then verify the upload landed:

```bash
rclone ls gdrive:pimote-builds | head
```

Report the final published filename to the user.
