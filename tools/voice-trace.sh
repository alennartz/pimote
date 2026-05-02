#!/usr/bin/env bash
# voice-trace.sh — tail the merged voice/call diagnostic stream from both
# pimote and speechmux systemd-user units, color-coded by source.
#
# Usage:
#   ./tools/voice-trace.sh             # follow live
#   ./tools/voice-trace.sh --since "10 minutes ago"
#
# Filters to lines containing `voice_trace` (server-side speechmux + pimote)
# or `[voice]` / `[voice_trace]` (pimote server) so you only see the
# diagnostic fire hose, not generic noise.

set -euo pipefail

SINCE_ARGS=()
if [[ "${1:-}" == "--since" ]]; then
  SINCE_ARGS+=(--since "$2")
  shift 2
fi

# ANSI color helpers.
GREEN=$'\e[32m'
BLUE=$'\e[34m'
YELLOW=$'\e[33m'
RED=$'\e[31m'
MAGENTA=$'\e[35m'
CYAN=$'\e[36m'
DIM=$'\e[2m'
RESET=$'\e[0m'

journalctl --user -u pimote -u speechmux -f "${SINCE_ARGS[@]}" --no-hostname \
  | grep --line-buffered -E "voice_trace|\[voice\]|\[conv\]|\[stt\]|\[tts\]|\[webrtc\]|\[ws\]|barge-in|FINAL|user turn complete" \
  | awk -v g="$GREEN" -v b="$BLUE" -v y="$YELLOW" -v r="$RED" -v m="$MAGENTA" -v c="$CYAN" -v d="$DIM" -v R="$RESET" '
    {
      color = ""
      if ($0 ~ /\[stt\]/)    color = y
      else if ($0 ~ /\[conv\]/)   color = g
      else if ($0 ~ /\[tts\]/)    color = c
      else if ($0 ~ /\[webrtc\]/) color = b
      else if ($0 ~ /\[ws\]/)     color = m
      else if ($0 ~ /BARGE-IN|DROPPED|abort/) color = r
      else if ($0 ~ /\[voice_trace\]/) color = d

      if (color != "") print color $0 R
      else print $0
    }
  '
