# Pimote Native Android Client

Native Kotlin Android client for pimote, optimized for sustained voice calls and Android Auto. See the `Android Client` section in [`codemap.md`](../../codemap.md) for module layout, and decision records [DR-016](../../docs/decisions/DR-016-native-kotlin-android-over-cross-platform.md), [DR-017](../../docs/decisions/DR-017-android-auth-at-network-layer.md), [DR-018](../../docs/decisions/DR-018-sessions-and-projects-as-telecom-phoneaccounts.md) for the architectural choices.

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
