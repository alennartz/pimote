# Brainstorm: Branch-Aware Transcript Navigation

## Idea

Make the transcript the primary surface for common linear-history navigation and
forking. Retain `/tree` for the rarer task of recovering an abandoned branch and
choosing an exact message within it. The feature manages branching conversation
shapes without forcing routine work into a tree dialog.

## Key decisions

### Message actions stay in the transcript

The user and assistant message faces expose the same conversation-navigation
actions. **Fork from here** is always available. **View existing forks** appears
only when the message has retained alternate continuations.

A user-message fork restores the selected user text to the composer for editing
before send. An assistant-message fork starts a new continuation from that
response. Existing Pi fork semantics and Pimote draft-conflict handling remain
the source of truth.

This keeps the common flow at the point the user already understands, instead
of making the user leave the transcript to invoke a command.

### Compaction is an explicit final choice

The default fork or branch-resume path uses no compaction. After the user picks
the exact target message, an opt-in **Custom compaction** control can collect
instructions and apply them. The flow does not offer generated summarization as
a separate choice.

This preserves the existing custom-compaction capability without adding a
summary decision to ordinary navigation.

### Main-transcript navigation is linear

`Ctrl-F` searches **conversation text** on the active visible branch only.
Conversation text means normal user-authored and model-authored text. Tool calls,
tool results, thinking, system entries, and custom display messages are outside
the first search scope.

The transcript also supports a simple jump to the previous user message. On
desktop, a one-line sticky preview shows the previous user message while its
full message is above the viewport. The preview carries the same human-message
actions. It detaches when the full message enters the viewport and the previous
user message takes its place. The full message keeps its normal full-height
rendering. Mobile uses a compact jump-up control instead of the sticky preview.

This provides orientation without adding permanent controls to every message or
using a large navigation surface for the common case.

### `/tree` becomes a branch explorer

Keep `/tree` for deliberate recovery of abandoned branches. A direct **View
existing forks** action can open the explorer focused on the selected fork. A
standalone `/tree` opens the complete session branch map.

The explorer is a large, indented responsive surface, not a dump of Pi's raw
event tree. Its initial view shows meaningful conversation structure:

- Show each branch's first meaningful message.
- Collapse its middle into a `[…]` segment.
- Show the branch's last meaningful message.
- Show a shared fork-point message once as the parent anchor.
- Recurse into child subtrees.
- Omit tool, bookkeeping, and other internal nodes.

The tree keeps indentation on desktop and mobile. It caps or compresses depth
on narrow screens rather than using horizontal scrolling.

Selecting a branch and expanding a `[…]` segment reveals its user and assistant
messages. The user can then select the exact message from which to fork or
resume and optionally apply custom compaction as the final step.

### `/tree` search progressively broadens

The first `/tree` search recursively indexes only the visible branch anchors and
previews. It does not search the contents hidden behind `[…]`.

If that search has no match, the explorer broadens to the complete session's
conversation text, including collapsed segments. A match expands the relevant
segment and selects the exact message. The full fallback search can move to the
server if client-side indexing is too expensive.

This keeps the common branch-map view fast and readable while preserving a path
to find a forgotten message anywhere in the session.

## Direction

Build one conversation-navigation model with two surfaces:

1. The transcript handles known points in the active branch: search, previous
   user-message jumps, and direct forking from a user or assistant message.
2. `/tree` handles unknown or abandoned branch recovery: compact branch topology,
   recursive exploration, exact-message selection, and optional custom
   compaction.

The surfaces share message identity, fork actions, and scroll anchoring, but do
not expose the same amount of branch structure. The protocol remains unchanged
unless architecture discovery proves that branch availability or full-session
search requires a new seam.

## Open questions

### Sharp technical questions

- Which existing Pi tree data identifies a fork point, a retained abandoned
  branch, and the first and last meaningful messages of a branch segment?
- Are all abandoned branches and their message identities available when a
  session opens, or does `/tree` need a refresh or lazy load?
- Can a UI action open the existing tree data flow with a focused fork without
  adding a wire command?
- Can the client search the complete session at acceptable cost, or does the
  fallback search need a server-side index or query?
- How does transcript virtualization expose stable message anchors for sticky
  previews, jump targets, and exact tree selections?
- What exact Pi behavior distinguishes forking from a user message, forking
  from an assistant message, and navigating to an abandoned branch?

### Fog

- Final labels and preview copy for fork points, abandoned branches, and the
  `[…]` segments.
- The keyboard shortcut for previous-user-message navigation.
- Whether the full `/tree` explorer also gets a non-command session-level entry
  point.
- The responsive density and depth cap for the indented mobile tree.
- The visual treatment for a selected branch and the final custom-compaction
  confirmation.
