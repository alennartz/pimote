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

**Status:** Open.

An await terminal visual reported idle while the sidepane disagreed. Later await invocations were not apparent in the UI.

Represent each await invocation and its terminal outcome correctly. Distinguish an interrupted or completed wait from a child's current state. Topology must converge to the actual child state.

## BUG-010: Apparent child send operations in the parent transcript

**Status:** Open. Root cause unconfirmed.

The user saw send operations attributed to child agents in the parent transcript.

A child's own tool operations belong in its child transcript. Messages delivered to the parent must be identifiable as incoming messages, not presented as the child's outgoing tool call.

## BUG-011: Live children without parent spawn entries

**Status:** Open. Root cause unconfirmed.

Subagents appeared in the sidepane without a corresponding visible spawning entry in the parent transcript.

Each spawn or resurrection must have a parent transcript entry linked to the resulting children.

## BUG-012: Await settles on idle despite an open session

**Status:** Open.

An await on a child settled as soon as the child went idle, even though the user had the session open.

Idle must not release an await while the user has the session open. The wait holds until the open-session condition ends.

## BUG-013: UI steering to a subagent window is not queued

**Status:** Open.

A steering message sent from the UI to a running subagent window did not queue for the child.

The UI must queue steering messages to a running subagent window and deliver them to the child.
