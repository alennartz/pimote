#!/usr/bin/env bash

# Shared paths, configuration readers, dependency checks, and host ADB helpers
# for the Android client tooling. Sourced by the other tools in this directory.

set -o pipefail

ANDROID_TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$ANDROID_TOOL_DIR/.." && pwd)"
ANDROID_ROOT_DIR="$(cd "$ANDROID_DIR/../.." && pwd)"

ANDROID_ENV_FILE="${ANDROID_ENV_FILE:-$ANDROID_DIR/.env.local}"
if [[ "$ANDROID_ENV_FILE" != /* ]]; then
    ANDROID_ENV_FILE="$ANDROID_ROOT_DIR/$ANDROID_ENV_FILE"
fi

ANDROID_IMAGE="${ANDROID_IMAGE:-pimote-android-builder:local}"
ANDROID_GRADLE_CACHE_VOLUME="${ANDROID_GRADLE_CACHE_VOLUME:-pimote-android-gradle-cache}"
ANDROID_HOME_VOLUME="${ANDROID_HOME_VOLUME:-pimote-android-home}"
ANDROID_APK_PATH="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"

ANDROID_DEVICE="${ANDROID_DEVICE:-}"
ANDROID_SERVER_URL="${ANDROID_SERVER_URL:-}"

android_error() {
    printf 'android: %s\n' "$*" >&2
    return 1
}

android_log() {
    printf 'android: %s\n' "$*" >&2
}

android_require_command() {
    local command_name=$1
    command -v "$command_name" >/dev/null 2>&1 || android_error "required command not found: $command_name"
}

android_require_docker() {
    android_require_command docker || return
    docker info >/dev/null 2>&1 || android_error "Docker daemon is not available"
}

android_require_image() {
    docker image inspect "$ANDROID_IMAGE" >/dev/null 2>&1 \
        || android_error "build image is missing: $ANDROID_IMAGE (run make android-image)"
}

# Read one dotenv value without evaluating the file. Values may be unquoted or
# surrounded by matching single or double quotes.
android_config_value() {
    local key=$1
    local line value

    [[ -f "$ANDROID_ENV_FILE" ]] || return 1

    while IFS= read -r line || [[ -n "$line" ]]; do
        line=${line%$'\r'}
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        if [[ "$line" =~ ^[[:space:]]*${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
            value=${BASH_REMATCH[1]}
            if [[ "$value" == \"*\" && "$value" == *\" ]]; then
                value=${value:1:${#value}-2}
            elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
                value=${value:1:${#value}-2}
            else
                value="${value%%[[:space:]]#*}"
                value="${value%${value##*[![:space:]]}}"
            fi
            printf '%s' "$value"
            return 0
        fi
    done < "$ANDROID_ENV_FILE"

    return 1
}

# Values already present in the environment win over the configuration file.
android_load_config() {
    local value

    if [[ -z "${ANDROID_DEVICE:-}" ]] && value=$(android_config_value ANDROID_DEVICE); then
        ANDROID_DEVICE=$value
    fi
    if [[ -z "${ANDROID_SERVER_URL:-}" ]] && value=$(android_config_value ANDROID_SERVER_URL); then
        ANDROID_SERVER_URL=$value
    fi
    if [[ -z "${ANDROID_ADB:-}" ]] && value=$(android_config_value ANDROID_ADB); then
        ANDROID_ADB=$value
    fi
    android_resolve_adb
}

# The host ADB server owns the pairing key, so the client must be the one that
# already paired. In WSL, the Windows executable shares the Windows key.
android_resolve_adb() {
    local candidate

    [[ -n "${ANDROID_ADB:-}" ]] && return 0

    for candidate in /mnt/c/Tools/android-sdk/platform-tools/adb.exe "$HOME/android/platform-tools/adb"; do
        if [[ -x "$candidate" ]]; then
            ANDROID_ADB=$candidate
            return 0
        fi
    done
    if command -v adb >/dev/null 2>&1; then
        ANDROID_ADB=$(command -v adb)
    fi
}

android_require_adb() {
    [[ -n "${ANDROID_ADB:-}" ]] && [[ -x "$ANDROID_ADB" ]] \
        || android_error "ADB executable is not available; set ANDROID_ADB in $ANDROID_ENV_FILE"
}

android_require_device_format() {
    [[ -n "${ANDROID_DEVICE:-}" ]] || return 0
    [[ "$ANDROID_DEVICE" =~ ^[^[:space:]]+:[1-9][0-9]*$ ]] \
        || android_error "ANDROID_DEVICE must be a wireless ADB address such as 192.168.1.240:40233"

    local port=${ANDROID_DEVICE##*:}
    (( port > 0 && port <= 65535 )) || android_error "ANDROID_DEVICE has an invalid port: $port"
}

android_require_server_url() {
    [[ -n "${ANDROID_SERVER_URL:-}" ]] || return 0
    [[ "$ANDROID_SERVER_URL" =~ ^https?://[^[:space:]]+$ ]] \
        || android_error "ANDROID_SERVER_URL must be an http(s) URL"
    [[ "$ANDROID_SERVER_URL" != *'@'* ]] \
        || android_error "ANDROID_SERVER_URL must not contain credentials"
}

android_print_server_url() {
    [[ -n "${ANDROID_SERVER_URL:-}" ]] || return 0
    printf 'ANDROID_SERVER_URL=%s\n' "$ANDROID_SERVER_URL"
    printf 'Enter this URL in the app on first launch.\n'
}

# Keep the client and the daemon on the loopback ADB socket. A caller-selected
# remote server must not decide which pairing key is in use.
android_setup_adb() {
    android_require_adb || return
    export ADB_SERVER_SOCKET=tcp:127.0.0.1:5037
    "$ANDROID_ADB" start-server >/dev/null 2>&1 \
        || android_error "could not start the host ADB server on 127.0.0.1:5037"
}

android_device_state() {
    local serial=$1
    "$ANDROID_ADB" devices 2>/dev/null | tr -d '\r' | awk -v serial="$serial" '$1 == serial { print $2; exit }'
}

android_attached_devices() {
    "$ANDROID_ADB" devices 2>/dev/null | tr -d '\r' | awk '$2 == "device" { print $1 }'
}

# Connect to one address. Wireless debugging reports connecting and authorizing
# for a short time, so wait for a settled state instead of one probe.
android_connect_address() {
    local address=$1
    local state output output_lower

    ANDROID_CONNECT_ERROR=""
    ANDROID_PAIRING_REQUIRED=false

    if ! output=$("$ANDROID_ADB" connect "$address" 2>&1); then
        ANDROID_CONNECT_ERROR=$output
        android_log "adb connect $address failed: ${output:-no diagnostic output}"
    elif [[ -n "$output" ]]; then
        android_log "adb connect $address: $output"
    fi

    output_lower=${output,,}
    if [[ "$output_lower" == *authenticat* || "$output_lower" == *unauthorized* \
        || "$output_lower" == *pairing* || "$output_lower" == *not\ paired* ]]; then
        ANDROID_PAIRING_REQUIRED=true
    fi

    for _ in {1..20}; do
        state=$(android_device_state "$address")
        case "$state" in
            device)
                return 0
                ;;
            unauthorized)
                ANDROID_PAIRING_REQUIRED=true
                return 1
                ;;
        esac
        sleep 0.5
    done

    state=$(android_device_state "$address")
    android_log "ADB device $address remained in state ${state:-absent} after waiting"
    return 1
}

# Prefer TLS connect services. Group records by advertised host, so one phone
# that offers both services is one candidate.
android_mdns_candidates() {
    local output
    output=$("$ANDROID_ADB" mdns services 2>/dev/null || true)
    output=${output//$'\r'/}
    awk '
        function remember(address, is_tls, host) {
            host = address
            sub(/:[0-9]+$/, "", host)
            if (is_tls) tls[host] = address
            else if (!(host in tls)) legacy[host] = address
        }
        {
            service = ""
            if ($0 ~ /adb-tls-connect[.]_tcp/) service = "tls"
            else if ($0 ~ /adb[.]_tcp/ || $0 ~ /_adb[.]tcp/) service = "legacy"
            if (!service) next
            for (field = 1; field <= NF; field++) {
                if ($field ~ /^[^[:space:]]+:[0-9]+$/) {
                    remember($field, service == "tls")
                }
            }
        }
        END {
            for (host in tls) print tls[host]
            for (host in legacy) if (!(host in tls)) print legacy[host]
        }
    ' <<< "$output" | sort -u
}

android_mdns_pairing_candidates() {
    local output
    output=$("$ANDROID_ADB" mdns services 2>/dev/null || true)
    output=${output//$'\r'/}
    awk '/adb-tls-pairing[.]_tcp/ {
        for (field = 1; field <= NF; field++) {
            if ($field ~ /^[^[:space:]]+:[0-9]+$/) print $field
        }
    }' <<< "$output" | sort -u
}

android_report_device() {
    local serial=$1
    local model android_version

    model=$("$ANDROID_ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n' || true)
    android_version=$("$ANDROID_ADB" -s "$serial" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r\n' || true)
    [[ -n "$model" ]] || model=unknown
    [[ -n "$android_version" ]] || android_version=unknown
    android_log "selected device: serial=$serial model=$model android=$android_version"
}

android_pairing_instructions() {
    local target=${1:-the phone}
    local pairing_address=${2:-}

    android_log "ADB could not authorize $target. Approve wireless debugging on the phone."
    if [[ -n "$pairing_address" ]]; then
        android_log "Advertised pairing address: $pairing_address"
    else
        android_log "Find the _adb-tls-pairing._tcp address with: $ANDROID_ADB mdns services"
    fi
    android_log "Then run once on the host:"
    android_log "  $ANDROID_ADB pair <pairing-address> <pairing-code>"
    android_log "Pairing addresses and codes are one-time inputs and are not saved."
}

android_server_diagnostics() {
    android_log "host ADB server status:"
    "$ANDROID_ADB" server-status 2>&1 | grep -E '^(version|mdns_enabled|mdns_backend):' >&2 || true
    android_log "no device was discovered; confirm the phone enables Wireless debugging"
}

# Resolve one wireless device. Logs go to stderr. The selected serial is the
# only stdout value, so callers never parse status text.
android_select_device() {
    local target=${1:-}
    local state candidate candidate_state
    local unauthorized_target=""
    local pairing_address=""
    local pairing_required=false
    local -a candidates=() pairing_services=() attached=()

    android_setup_adb || return

    if [[ -n "$target" ]]; then
        state=$(android_device_state "$target")
        if [[ "$state" == "device" ]]; then
            android_report_device "$target"
            printf '%s\n' "$target"
            return 0
        fi
        [[ "$state" == "unauthorized" ]] && unauthorized_target="$target"
        if android_connect_address "$target"; then
            android_report_device "$target"
            printf '%s\n' "$target"
            return 0
        fi
        [[ "${ANDROID_PAIRING_REQUIRED:-false}" == true ]] && pairing_required=true
        state=$(android_device_state "$target")
        [[ "$state" == "unauthorized" ]] && unauthorized_target="$target"
    fi

    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] && candidates+=("$candidate")
    done < <(android_mdns_candidates)
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] && pairing_services+=("$candidate")
    done < <(android_mdns_pairing_candidates)
    if (( ${#pairing_services[@]} > 0 )); then
        pairing_address=${pairing_services[0]}
    fi

    if (( ${#candidates[@]} > 1 )); then
        android_error "more than one wireless ADB device was discovered; set ANDROID_DEVICE instead"
        printf '  %s\n' "${candidates[@]}" >&2
        return 1
    fi

    if (( ${#candidates[@]} == 1 )); then
        candidate=${candidates[0]}
        candidate_state=$(android_device_state "$candidate")
        [[ "$candidate_state" == "unauthorized" ]] && unauthorized_target="$candidate"
        if [[ "$candidate_state" == "device" ]]; then
            android_report_device "$candidate"
            printf '%s\n' "$candidate"
            return 0
        fi
        if android_connect_address "$candidate"; then
            if [[ -n "$target" ]]; then
                android_log "connected through mDNS at $candidate; update ANDROID_DEVICE to keep it"
            else
                android_log "connected through mDNS at $candidate"
            fi
            android_report_device "$candidate"
            printf '%s\n' "$candidate"
            return 0
        fi
        [[ "${ANDROID_PAIRING_REQUIRED:-false}" == true ]] && pairing_required=true
        candidate_state=$(android_device_state "$candidate")
        [[ "$candidate_state" == "unauthorized" ]] && unauthorized_target="$candidate"
    fi

    if [[ -n "$unauthorized_target" || "$pairing_required" == true ]]; then
        android_pairing_instructions "${unauthorized_target:-${target:-the phone}}" "$pairing_address"
        android_error "could not authorize a wireless ADB device${target:+ at $target}"
        return 1
    fi

    # A phone on USB advertises nothing over mDNS. Use it only when it is the
    # single attached device, so the choice stays unambiguous.
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] && attached+=("$candidate")
    done < <(android_attached_devices)
    if (( ${#attached[@]} == 1 )); then
        android_log "using the single attached device ${attached[0]}"
        android_report_device "${attached[0]}"
        printf '%s\n' "${attached[0]}"
        return 0
    fi
    if (( ${#attached[@]} > 1 )); then
        android_error "more than one device is attached; set ANDROID_DEVICE or detach all but one"
        printf '  %s\n' "${attached[@]}" >&2
        return 1
    fi

    android_server_diagnostics
    android_error "no usable ADB device${target:+ at $target}; nothing was selected"
    return 1
}
