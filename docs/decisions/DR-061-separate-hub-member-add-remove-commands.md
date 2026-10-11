# DR-061: Separate add_hub_member and remove_hub_member commands

## Status

Accepted

## Context

Hub membership mutation needed a wire shape. Members join and leave one at a time
from a dialog, and each mutation has distinct inputs and validation: add checks
discovery, duplicate basenames, and hub eligibility; remove must work when the
member folder is already gone. The options were two single-purpose commands or one
combined `update_hub` patch command.

## Decision

Two commands — `add_hub_member` and `remove_hub_member` — each carrying hub and
member paths. A combined patch shape was rejected because it would force the wire to
express ordering and multi-member operations the product never needs: every UI
mutation is a single add or a single remove.

## Consequences

- Each command's validation and error message map one-to-one onto one user action.
- Batch edits would need N round-trips; no surface produces them.
- A future `update_hub` for other hub fields (rename, tags) stays open; membership
  simply does not ride it.
