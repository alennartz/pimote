# Subagent UI bugs

## BUG-001: Transcript loss and duplicate user messages

**Status:** Fixed in source. Deployment pending.

Sending a user message after projected subagent content could overwrite the previous assistant answer or duplicate the user message. Projection changed transcript rows without matching render keys and dropped pending user entries.

The fix preserves transcript rows, render keys, and pending messages in root and child views. Commit: `4ccff84` in Pimote.

## BUG-002: Duplicate await and completion blocks

**Status:** Fixed in source. Deployment pending.

One `await_agents` call rendered an await block and a separate child completion block. The extension supplied two operation IDs for the same returned completion.

Await results now contain returned child completions. Standalone completion blocks replace asynchronous custom messages only. Saved-result hydration follows the same rule without rewriting JSONL.

Commits: `ffda0a7` in `my-pi`, pushed to `origin/main`, and `c12857b` in Pimote.

## BUG-003: Empty await body and missing tool parameters

**Status:** Fixed in source. Deployment pending.

An await block had no body before child statuses arrived, despite the call naming `sleeper`. The renderer ignored requested targets. The extension also omitted target updates and final target parameters.

Await starts after complete model arguments arrive. Named targets appear as a list. Omitted targets display **All agents**. Final tool-backed semantic payloads retain complete displayable parameters and results. Existing event types remain unchanged.

## BUG-004: Inconsistent semantic text rendering

**Status:** Fixed in source. Deployment pending.

Semantic cards used different typography and plain text instead of the transcript Markdown renderer. Some summaries also omitted received fields or displayed output instead of an accompanying error.

All free-form semantic parameter and result text uses the existing Markdown renderer and transcript typography. Metadata remains labeled. Outputs, errors, outcome flags, session IDs, and received usage fields remain visible.

## BUG-005: Removal notice never expires

**Status:** Fixed in source. Deployment pending.

The panel's **sleeper was removed** notice remained indefinitely.

Removal notices now disappear automatically after 10 seconds. Auto-dismissal clears the persisted removal entry, and resurrection request prompts stay on screen until dismissed. Commit: `2bbb3d6` in Pimote.

## BUG-006: Panel labels and root visibility

**Status:** Fixed in source. Deployment pending.

The panel displayed an **Extensions** label and a root session row without live children. Subagent visuals appeared under **Hierarchy** rather than **Subagents**.

The header now shows the live count only when children exist. The root row appears only when children exist. Subagent rows appear under a Subagents header. Commit: `81f2613` in Pimote.

## BUG-007: Manual teardown is difficult to find

**Status:** Fixed in source. Deployment pending.

The user could not find the manual teardown control. It currently appears at the bottom of the inspector after selecting a live child row.

Every live child row now carries a teardown affordance at its trailing edge. The control is always visible on live rows, never on terminal rows, opens the same confirmation dialog, and leaves row click-to-inspect intact. The inspector teardown button stays in place. Commit: `2f5890d` in Pimote.

## BUG-008: Empty hidden custom message reaches the transcript

**Status:** Fixed in source. Deployment pending.

An empty generic `subagents` custom-message block became visible.

The projector now emits the projected row for a hidden custom entry only when the row carries subagent content. Malformed payloads still produce protocol errors. Commit: `b49189b` in Pimote.

## BUG-009: Await lifecycle and sidepane disagree

**Status:** Fixed in source. Deployment pending.

An await terminal visual reported idle while the sidepane disagreed. Later await invocations were not apparent in the UI.

Represent each await invocation and its terminal outcome correctly. Distinguish an interrupted or completed wait from a child's current state. Topology must converge to the actual child state.

Commits: ae309534dc799d3939c747ef68423e3d8debca02 in my-pi, pushed to origin/main.

## BUG-010: Apparent child send operations in the parent transcript

**Status:** Fixed in source. Deployment pending.

The user saw send operations attributed to child agents in the parent transcript.

Incoming messages and deferred replies now identify the sender and display the message body. Outgoing sends remain separate. Historical entries with a sender and no parameters render as received messages.

Commits: 0a7f4275348de1bd138719f9a2869c2dc4f059bf in my-pi, pushed to origin/main, and 9d30f3cbb36d29f8ce9a19f53d0827ac279f9316 in Pimote.

## BUG-011: Live children without parent spawn entries

**Status:** Partially fixed in source. Deployment pending.

Subagents appeared in the sidepane without a corresponding visible spawning entry in the parent transcript.

UI-initiated resurrection and manual teardown inform the parent turn through a custom `subagents` message delivered as next turn, so the parent model learns of the event without a turn being triggered. Each notice carries persisted presentation content, rides the hidden-custom-type manifest, and rehydrates from the parent transcript through the provider. Model-issued root spawns retain their existing entries.

Nested spawns and resurrections remain visible only in the spawning child's transcript. The root transcript still lacks an entry for those descendants. A root entry needs explicit child attribution and durable cross-session provenance to avoid attributing the operation to the root.

Commits: de93fb8656c454b076ed2b394609cc504e2760fc and 7492a1c in my-pi, pushed to origin/main, and 6f103ebcf4e21d1e717e3ddba555b309c7a537d2 and 1f274e3 in Pimote.

## BUG-012: Await settles on idle despite an open session

**Status:** Fixed in source. Deployment pending.

An await on a child settled as soon as the child went idle, even though the user had the session open.

Open child views retain their leases across disconnects. An unavailable view no longer marks a running child as stopped. Idle waits release when the open-session condition ends.

Commits: 52f6d95a94eba2835aa239b95bd660f20c6e8b62 in my-pi, pushed to origin/main, and 6f81439413496a17ed036b299ee31023deae475c in Pimote.

## BUG-013: UI steering to a subagent window is not queued

**Status:** Fixed in source. Deployment pending.

A steering message sent from the UI to a running subagent window did not queue for the child.

The UI must queue steering messages to a running subagent window and deliver them to the child.

Commits: 939846eb24c34b538cb522f78ec61325ad5b8120 in Pimote.

## BUG-014: Child view froze at its pre-disconnect state

**Status:** Fixed in source. Deployment pending.

A child view kept showing the state it had when the app lost its socket, while the parent received the child's idle notification. The server released the view during the gap, the closed notice went to a dead socket, and no later frame corrected the client. Clicking the child again re-selected the dead view instead of reopening it.

Child views now sync as observed session surfaces. A reconnect asks for each open view with its cursor; the server answers with a delta or a snapshot, and a path it cannot serve answers `subagent_view_unavailable` so the ghost closes through a response instead of a lost push.

Commits: 8884704 and fd6e7be in Pimote. Model: DR-089.
