# Pimote Native Android Client

Native Kotlin Android client for pimote, optimized for sustained voice calls and Android Auto. See [`docs/plans/native-android-client.md`](../../docs/plans/native-android-client.md) for the architecture.

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
