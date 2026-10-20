# Pimote manager reference

Reference for the manager session: its folder, persona, hub, and session tools, and how to read the other shipped docs. Read it before you change folder structure, membership, or sessions through the manager.

## Tool surface

| Tool                        | Job                                                                                                                         | Notes                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pimote_list_folders`       | Rows: every folder with nature, curation, git facts (`repo`, hub `repos`), hub membership (`members`), live session counts. | `nature` filter gives the team view (personas) or code view. `fresh: true` drops the discovery cache first. Payload is `{ folders, spill? }`. |
| `pimote_list_sessions`      | One sessions view: disk history with live state on open rows.                                                               | Filters: `query` (name + first message), `folderPath`, `open`. Newest first, capped. Payload is `{ sessions, spill? }`.                       |
| `pimote_start_session`      | Open a session in a known folder.                                                                                           | `firstMessage` tasks it at once; the run continues in the background.                                                                         |
| `pimote_archive_sessions`   | Mark records archived; evict open slots.                                                                                    | Per-id outcomes. No unarchive tool exists.                                                                                                    |
| `pimote_create_folder`      | Create one of the four kinds.                                                                                               | `kind`: `code`, `persona`, `code-hub`, `persona-hub`. Persona kinds need `description`; hub kinds need `memberPaths`.                         |
| `pimote_update_folder`      | Curate: favorite, archive or restore, tags.                                                                                 | `archived: false` restores. Keyed by canonical path.                                                                                          |
| `pimote_update_hub_members` | Batch hub membership.                                                                                                       | Removals run before additions. Per-member outcomes.                                                                                           |

## Large results: the spill guard

A list result whose serialized rows exceed 16KB keeps only the inline prefix that fits. The result then carries a `spill` field: the absolute path of a JSONL file holding the remaining rows in the same order, the spilled row count, and a search hint. Search the file with `jq` or `grep` instead of re-calling the tool with a bigger limit — one JSON object per line, so `jq -c 'select(.name // .id | test("PATTERN"; "i"))' <file>` works directly. Prefer tighter filters (`query`, `folderPath`, `nature`) when you know what you are looking for; the spill file is for wide sweeps.

The guard bounds only the result you see. Codemode scripts calling these tools receive every row in `structuredContent` and never need the spill file.

## Interruption

The two list tools take the turn's abort signal, and both reject promptly when it fires. Shared server-side work — the discovery walk, the per-folder session cache fills — never dies with a caller: it runs to completion and serves the next reader. Request paths abort; cache fills complete. The walk's 50,000-visit budget, the caches' TTLs, and single-flight dedup bound that work regardless.

## Freshness

Discovery (the folder listing and its repo facts) is cached on a 30-second TTL with stale-while-revalidate. A plain read may serve data up to one TTL old while a background refresh runs. This explains stale rows after manual `mv` or `ln`. Pass `fresh: true` on a read to drop the cache and block on a fresh walk. Tool mutations invalidate and broadcast immediately, so results reflect them at once.

## The one walk rule that prevents wrong shapes

Every included folder, code or persona, is a leaf. Real subfolders inside it stay undiscovered. Only its top-level symlinks that point outside it are followed, as shortcuts to the target folder. Hub membership is symlinks, never nesting. When a folder seems missing after you moved or linked things by hand, do not conclude the model rejected it. Read with `fresh: true` first.

## Memory

`memory.md` in the manager folder holds facts about this installation and the user's preferences. Product rules live in the shipped docs, not in `memory.md`.

## Other shipped docs

- `folders.md`: the folder model, nature detection, identity, hubs, curation, and sessions.
- `recipes.md`: topology recipes for the four folder kinds, with expected shapes and anti-patterns.
- `static-reports.md`: design guide for HTML reports hosted with `pimote_static_host`.
