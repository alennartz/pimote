# Pimote Native Android Client

Native Kotlin Android client for pimote, optimized for sustained voice calls and Android Auto. See the `Android Client` section in [`codemap.md`](../../codemap.md) for module layout, and decision records [DR-016](../../docs/decisions/DR-016-native-kotlin-android-over-cross-platform.md), [DR-017](../../docs/decisions/DR-017-android-auth-at-network-layer.md), and [DR-019](../../docs/decisions/DR-019-sessions-and-projects-as-contactscontract-contacts.md) (which supersedes DR-018) for the architectural choices.

## Build toolchain

Gradle runs inside a self-contained Docker image with JDK 17, Android SDK 36, and
build-tools 36.0.0. The host needs Docker, and `adb` for device work.

`versions.env` holds every toolchain pin. `tools/android-image` passes each pin
to the image build, and `build.Dockerfile` fails when an installed version
disagrees with its pin. The base image is pinned by OCI digest.

```bash
make android-image     # build pimote-android-builder:local, ~1.5 GB
make android-build     # assemble the debug APK
make android-test      # unit tests
make android-tooling-test  # host device selection, no Docker or phone
```

APK output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Gradle and the Android debug signing key live outside the checkout:

- `pimote-android-gradle-cache` holds `GRADLE_USER_HOME`.
- `pimote-android-home` holds `HOME` and `user.home`. Android signs every debug
  APK with `user.home/.android/debug.keystore`, so this volume keeps one key
  across containers and `adb install -r` updates the app in place.

A key left by the older repo-local `HOME` seeds the volume on first use. Delete
`.docker-home/` and `.gradle-cache/` afterwards. Wipe the cache volume with
`docker volume rm pimote-android-gradle-cache`; never remove the home volume
unless your phone may lose the app signature.

```bash
make android-shell                    # interactive shell in the container
make android-gradle ARGS="<task>"     # arbitrary gradle task
make android-clean                    # gradle clean
```

## Device configuration

Copy the example and edit the ignored local file:

```bash
cp mobile/android/.env.example mobile/android/.env.local
chmod 600 mobile/android/.env.local
```

Every value is optional. The tooling reads the file without evaluating it, so a
stray command in the file runs nothing. Invalid values fail before Docker
builds or device changes.

`ANDROID_DEVICE` is the phone's wireless ADB **connect** address, not the host
ADB server port and not the server URL. `ANDROID_SERVER_URL` is printed before
an install as a reminder of the URL to enter in the app.

## Wireless debugging

The container never touches a device. ADB, pairing, and installs run on the
host, because the pairing key is host state.

```bash
make android-connect   # connect and verify the phone, print its serial
make android-install   # select the phone, build, then adb install -r
```

The tools resolve `ANDROID_ADB` from the environment, then from
`/mnt/c/Tools/android-sdk/platform-tools/adb.exe` in mirrored WSL, then from
`~/android/platform-tools/adb`, then from `PATH`. Choose the executable whose
ADB server already holds your pairing key. Every tool forces
`ADB_SERVER_SOCKET=tcp:127.0.0.1:5037`, so a caller-selected remote server
cannot decide which key is in use.

Selection tries `ANDROID_DEVICE` first. When the saved address fails, it uses
only mDNS wireless **connect** services and prefers TLS records over legacy
ones. One advertised host is one candidate, so a phone that offers both services
stays one candidate. Two candidates is an error: the addresses are listed and
`ANDROID_DEVICE` must choose. With no configured address, one candidate is used.

A phone on USB advertises nothing over mDNS. When discovery finds no candidate,
a single attached device is selected, so the same targets work over USB. More
than one attached device is an error.

A device that reports `connecting` or `authorizing` is polled for up to ten
seconds instead of being treated as a failure. An unauthorized device prints the
one-time pairing step:

```bash
adb pair <pairing-address> <pairing-code>
```

Pairing addresses and codes are one-time inputs. Enter them directly; do not
save them in `.env.local` or the repository. The `adb connect` port changes
each time wireless debugging restarts, and discovery reports the new address
without rewriting your configuration.

## Diagnostics

- `adb devices -l` lists host devices. In mirrored WSL this is the Windows ADB
  server.
- `adb server-status` reports the server version and whether mDNS is enabled.
  Wireless discovery needs `mdns_enabled: true`.
- `adb mdns services` lists advertised connect and pairing services.
- `make android-tooling-test` checks selection without a phone or Docker.
- Keep the ADB daemon on loopback. Never expose port 5037 on the LAN.

## Android Auto

`dhu.sh` runs the Desktop Head Unit against a USB-connected phone. Run it from
the host; it is not a `make` target.
