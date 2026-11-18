#!/usr/bin/env bash
set -Eeuo pipefail

# Wireless device selection without a phone, Docker, or network. A stub adb
# first on PATH answers the host commands the tooling issues.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
connect_tool="$root/mobile/android/tools/android-connect"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

failures=0

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    failures=$((failures + 1))
}

dump_stderr() {
    while IFS= read -r line; do printf '  %s\n' "$line" >&2; done < "$1/stderr"
}

# Instant sleep keeps the transient-state wait out of the test's run time.
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/sleep"
chmod +x "$work/bin/sleep"

cat > "$work/bin/adb" <<'ADB'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${STUB_DIR:?STUB_DIR is required}"
case "$1" in
    start-server)
        exit 0
        ;;
    server-status)
        printf 'version: "37.0.1"\nmdns_enabled: true\nmdns_backend: LIBADBMDNS\n'
        ;;
    devices)
        calls=$(( $(cat "$STUB_DIR/devices.calls" 2>/dev/null || printf '0') + 1 ))
        printf '%s\n' "$calls" > "$STUB_DIR/devices.calls"
        printf 'List of devices attached\n'
        visible=false
        case "${STUB_VISIBLE:-connected}" in
            always) visible=true ;;
            connected) [[ -f "$STUB_DIR/connected" ]] && visible=true ;;
        esac
        if $visible; then
            state=${STUB_STATE:-device}
            if [[ -n "${STUB_CONNECTING_PROBES:-}" ]] && (( calls <= STUB_CONNECTING_PROBES )); then
                state=connecting
            fi
            printf '%s %s\n' "$STUB_DEVICE" "$state"
        fi
        ;;
    connect)
        if [[ -n "${STUB_CONNECT_FAILURE:-}" ]]; then
            printf '%s\n' "$STUB_CONNECT_FAILURE" >&2
            exit 1
        fi
        if [[ "$2" == "$STUB_DEVICE" ]]; then
            : > "$STUB_DIR/connected"
            printf 'connected to %s\n' "$2"
        else
            printf 'cannot resolve host %s\n' "$2" >&2
            exit 1
        fi
        ;;
    mdns)
        eol=${STUB_EOL:-$'\n'}
        printf 'List of discovered mdns services%s' "$eol"
        if [[ "${STUB_MDNS_COUNT:-1}" -ge 1 ]]; then
            printf 'adb-phone\t_adb-tls-connect._tcp\t%s%s' "$STUB_DEVICE" "$eol"
        fi
        if [[ -n "${STUB_LEGACY_DEVICE:-}" ]]; then
            printf 'adb-legacy\t_adb._tcp\t%s%s' "$STUB_LEGACY_DEVICE" "$eol"
        fi
        if [[ "${STUB_MDNS_COUNT:-1}" -ge 2 ]]; then
            printf 'adb-other\t_adb-tls-connect._tcp\t%s%s' "$STUB_SECOND_DEVICE" "$eol"
        fi
        if [[ -n "${STUB_PAIRING_ADDRESS:-}" ]]; then
            printf 'adb-pairing\t_adb-tls-pairing._tcp\t%s%s' "$STUB_PAIRING_ADDRESS" "$eol"
        fi
        ;;
    -s)
        case "${*: -1}" in
            ro.product.model) printf 'Pixel 8\n' ;;
            ro.build.version.release) printf '17\n' ;;
            *) exit 1 ;;
        esac
        ;;
    *)
        exit 1
        ;;
esac
ADB
chmod +x "$work/bin/adb"

# run_connect <case dir> [KEY=VALUE...] runs android-connect and leaves its
# stdout, stderr, and status in the case directory.
run_connect() {
    local dir=$1
    shift
    mkdir -p "$dir"
    env \
        PATH="$work/bin:$PATH" \
        ANDROID_ADB="$work/bin/adb" \
        STUB_DIR="$dir" \
        "$@" \
        bash "$connect_tool" \
        > "$dir/stdout" 2> "$dir/stderr"
}

expect_serial() {
    local dir=$1 label=$2 expected=$3
    if [[ "$(<"$dir/stdout")" == "ANDROID_SERIAL=$expected" ]]; then
        printf 'PASS: %s\n' "$label"
    else
        fail "$label: stdout was '$(<"$dir/stdout")'"
        dump_stderr "$dir"
    fi
}

device=192.168.1.240:40233

for format in unix windows; do
    dir="$work/stale-$format"
    if [[ "$format" == windows ]]; then eol=$'\r\n'; else eol=$'\n'; fi
    mkdir -p "$dir"
    env_file="$dir/.env.local"
    printf 'ANDROID_DEVICE=192.168.1.240:36479\n# keep me\n' > "$env_file"
    before=$(cksum < "$env_file")
    # The phone advertises a TLS and a legacy service for one address. One phone
    # is one candidate, and a saved address that no longer resolves must not
    # stop the selection.
    if STUB_DEVICE=$device STUB_LEGACY_DEVICE=$device STUB_EOL="$eol" \
        run_connect "$dir" ANDROID_ENV_FILE="$env_file"; then
        expect_serial "$dir" "stale address recovers through mDNS ($format output)" "$device"
    else
        fail "stale address recovery exited non-zero ($format output)"
        dump_stderr "$dir"
    fi
    [[ "$(cksum < "$env_file")" == "$before" ]] || fail "discovery rewrote $env_file ($format output)"
done

dir="$work/no-config"
if run_connect "$dir" ANDROID_ENV_FILE="$dir/absent.env" STUB_DEVICE=$device; then
    expect_serial "$dir" "discovery works without a configuration file" "$device"
else
    fail "discovery without a configuration file exited non-zero"
    dump_stderr "$dir"
fi

# A phone on USB advertises nothing over mDNS.
dir="$work/attached"
if run_connect "$dir" ANDROID_ENV_FILE="$dir/absent.env" \
    STUB_DEVICE=$device STUB_VISIBLE=always STUB_MDNS_COUNT=0; then
    expect_serial "$dir" "a single attached device is selected without discovery" "$device"
else
    fail "a single attached device was rejected"
    dump_stderr "$dir"
fi

dir="$work/transient"
if run_connect "$dir" ANDROID_ENV_FILE="$dir/absent.env" ANDROID_DEVICE=$device \
    STUB_DEVICE=$device STUB_CONNECTING_PROBES=2; then
    expect_serial "$dir" "a connecting device settles instead of failing" "$device"
else
    fail "a transient connecting state was treated as failure"
    dump_stderr "$dir"
fi

dir="$work/ambiguous"
if run_connect "$dir" ANDROID_ENV_FILE="$dir/absent.env" \
    STUB_DEVICE=$device STUB_SECOND_DEVICE=192.168.1.241:40111 STUB_MDNS_COUNT=2; then
    fail "two discovered devices were accepted without a choice"
else
    if [[ -s "$dir/stdout" ]]; then
        fail "an ambiguous discovery wrote a serial to stdout"
    elif ! grep -q 'more than one wireless ADB device' "$dir/stderr"; then
        fail "an ambiguous discovery did not explain the conflict"
        dump_stderr "$dir"
    else
        printf 'PASS: two discovered devices stop the selection\n'
    fi
fi

dir="$work/unauthorized"
if run_connect "$dir" ANDROID_ENV_FILE="$dir/absent.env" ANDROID_DEVICE=192.168.1.240:36479 \
    STUB_DEVICE=$device STUB_VISIBLE=always STUB_STATE=unauthorized \
    STUB_CONNECT_FAILURE='failed to authenticate to 192.168.1.240:36479' \
    STUB_PAIRING_ADDRESS=192.168.1.240:49999; then
    fail "an unauthorized device was accepted"
else
    if grep -q 'pair <pairing-address> <pairing-code>' "$dir/stderr"; then
        printf 'PASS: an unauthorized device reports the pairing step\n'
    else
        fail "an unauthorized device did not report the pairing step"
        dump_stderr "$dir"
    fi
fi

if (( failures > 0 )); then
    printf '%d check(s) failed\n' "$failures" >&2
    exit 1
fi
