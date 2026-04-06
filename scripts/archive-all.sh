#!/usr/bin/env bash
# Archive all pimote sessions.
# Reads existing metadata, finds all session .jsonl files for configured roots,
# and marks every session as archived in the metadata file.
#
# Usage: ./scripts/archive-all.sh [--dry-run]

set -euo pipefail

METADATA_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/pimote/session-metadata.json"
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/pimote/config.json"
SESSION_BASE="$HOME/.pi/agent/sessions"
DRY_RUN=false

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: config not found at $CONFIG_FILE" >&2
  exit 1
fi

python3 - "$METADATA_FILE" "$CONFIG_FILE" "$SESSION_BASE" "$DRY_RUN" <<'PYEOF'
import json, sys, os, glob
from datetime import datetime, timezone

metadata_file, config_file, session_base, dry_run_str = sys.argv[1:5]
dry_run = dry_run_str == "true"

# Load config roots
with open(config_file) as f:
    roots = json.load(f)["roots"]

# Load existing metadata
if os.path.isfile(metadata_file):
    with open(metadata_file) as f:
        metadata = json.load(f)
else:
    metadata = {"version": 1, "sessions": {}}

sessions = metadata.setdefault("sessions", {})
now = datetime.now(timezone.utc).isoformat()

# For each root, find subdirectories (project folders) and their session dirs
new_count = 0
skip_count = 0

for root in roots:
    if not os.path.isdir(root):
        continue
    for entry in sorted(os.listdir(root)):
        project_path = os.path.join(root, entry)
        if not os.path.isdir(project_path):
            continue
        # Encode path the same way pi does: strip leading /, replace / with -, wrap with --
        encoded = "--" + project_path.lstrip("/").replace("/", "-") + "--"
        session_dir = os.path.join(session_base, encoded)
        if not os.path.isdir(session_dir):
            continue
        for jsonl in sorted(glob.glob(os.path.join(session_dir, "*.jsonl"))):
            if jsonl in sessions and sessions[jsonl].get("archived"):
                skip_count += 1
                continue
            new_count += 1
            if dry_run:
                print(f"  [dry-run] would archive: {os.path.basename(jsonl)}")
            else:
                sessions[jsonl] = {"archived": True, "archivedAt": now}

total = new_count + skip_count
print(f"\nTotal sessions found: {total}")
print(f"Already archived:     {skip_count}")
print(f"Newly archived:       {new_count}")

if not dry_run and new_count > 0:
    os.makedirs(os.path.dirname(metadata_file), exist_ok=True)
    tmp = metadata_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(metadata, f, indent=2)
        f.write("\n")
    os.rename(tmp, metadata_file)
    print(f"\nMetadata written to {metadata_file}")
    print("Restart the server or reload the page for changes to take effect.")
elif dry_run:
    print("\nDry run — no changes made.")
else:
    print("\nNothing to archive.")
PYEOF
