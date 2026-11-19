# Sessions

A session is one conversation with pi. Pimote stores records per folder, holds open sessions in server slots, and lets several browsers observe the same slot. Read this page before you start, resume, or archive a session.

## Records and slots

A session record is pi's JSONL session file for the folder, plus Pimote metadata that holds the display name, the archive flag, and cost. Records survive a restart and stay in their folder.

A **slot** is one running session. It holds the pi runtime, a replay buffer, and its observers. A second browser that opens the same session attaches an observer to the existing slot. It does not start a second runtime.

## Folders that accept sessions

A new session starts only in a known folder row: a code folder, a persona, a hub, or a source-listed folder.

These places accept none:

- The manager root. It never appears as a row.
- A folder nested inside an included folder. The walk treats included folders as leaves, so the folder is invisible.
- A row with `missing: true`.

An archived folder still holds its sessions, and those sessions still appear in `pimote_find_sessions`.

A persona folder runs the session rooted in itself. Its `AGENTS.md` is the prompt.

## Live state

`pimote_find_sessions` reports `status` and `needsAttention` for open sessions.

| Field            | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `status`         | `working` while a turn runs, `idle` between turns.                           |
| `needsAttention` | A decision waits: a permission prompt, a dialog, or an extension UI request. |

## Start, resume, archive

`pimote_start_session` opens a new session and dispatches an optional first message in the background. Pimote reports that the dispatch was requested, not that the turn completed.

`pimote_resume_session` reopens the original record and clears its archive flag. It returns `resumed`, `already_open`, or `not_found`, and it never creates a replacement session.

`pimote_archive_sessions` hides records without deleting them. It closes the live runtime and its observers first, which stops a running turn. Outcomes are `archived`, `open_slot_evicted`, and `not_found`.

## Idle reaping

Pimote closes sessions that hold no work. It checks every 60 seconds and closes a session whose idle time exceeds `idleTimeout`, which defaults to 30 minutes.

A session is busy, and stays open, while any of these holds:

- A browser observes it.
- A voice call is active.
- A bash command runs, or a bash dispatch is in flight.
- Tree navigation is in progress.
- A turn has not settled.
- An extension reports background work.

Closing a reaped session ends its runtime. Its record stays on disk and reopens on demand.

The activity poll gives extensions a veto. Before closing, Pimote emits `pimote:activity:request` on the session event bus and reads the answer synchronously. An extension that manages work the root session cannot see registers a responder:

```ts
import { answerActivity } from '@pimote/sdk/activity';

answerActivity(pi, () => myAgents.some((agent) => agent.state === 'running'));
```

A responder that throws answers `active: true`, so a broken predicate parks the session instead of destroying work. With no responder, the base rule applies. `@pimote/sdk` documents the rest of the API.

## Interrupted runs

A session that lost its process mid-turn continues on its next load. Pimote appends a hidden `session-idle` marker when a turn finishes on its own terms, and gives a session without that marker one continuation turn at load.

Pimote records no marker when it tears a runtime down mid-turn, as at server shutdown, so those sessions also continue when they load next.
