# Pimote Native Android Client

Native Kotlin Android client for pimote, optimized for sustained voice calls and Android Auto. See the `Android Client` section in [`codemap.md`](../../codemap.md) for module layout, and decision records [DR-016](../../docs/decisions/DR-016-native-kotlin-android-over-cross-platform.md), [DR-017](../../docs/decisions/DR-017-android-auth-at-network-layer.md), and [DR-019](../../docs/decisions/DR-019-sessions-and-projects-as-contactscontract-contacts.md) (which supersedes DR-018) for the architectural choices.

## Build toolchain

The Android build runs inside a self-contained Docker image that bundles JDK 17, the Android SDK 34, and required platform/build tools. The host needs Docker and (for installs) `adb`.

### One-time image build

```bash
make android-image
```

This builds `pimote-android-builder:local`. ~1.5 GB image, ~3–5 min on first build.

### Gradle commands

```bash
make android-build                  # assemble debug APK
make android-test                   # run unit tests
make android-shell                  # interactive shell with gradle/sdk on PATH
make android-gradle ARGS="<task>"   # arbitrary gradle invocation
```

APK output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

### Installing on a device

The container does not access devices. Install from the host:

```bash
# Wireless
adb pair <ip>:<port>
adb connect <ip>:<port>
adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk

# USB
adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

**Test device IP (static, reserved on home LAN):** `192.168.1.240`

The wireless-debug `adb pair` / `adb connect` ports are _not_ static — Android
randomizes them each time wireless debugging is toggled. The pairing port is
shown alongside the 6-digit pairing code in Settings → Developer options →
Wireless debugging → Pair device with pairing code. The `adb connect` port is
shown on the main Wireless debugging screen.
