# Tree Navigation in Pimote

## The Idea

Bring the TUI's `/tree` command to pimote — full-featured session tree navigation accessible from the PWA on both desktop and mobile. The TUI version is a keyboard-driven terminal modal; the pimote version adapts the same functionality to web interaction patterns (tap, click, scroll) while preserving full feature parity.

## Key Decisions

### UI Pattern: Collapsible List

**Chose collapsible list (outline/accordion) over faithful tree rendering or breadcrumb navigation.** The TUI's indented `├─` connector style works in a monospaced terminal but gets cramped on mobile. A collapsible list uses horizontal space efficiently, handles deep trees well, and is naturally touch-friendly. The TUI already has fold/unfold concepts (`⊞`/`⊟`) so the mental model translates directly. Desktop and mobile use the same component, just sized differently.

### Entry Point: Slash Command

**`/tree` slash command, no persistent UI button for now.** Matches the TUI's entry point. A persistent affordance (status bar button, breadcrumb trail) can be added later once the right placement becomes clear through actual use.

### Summarization: Server-Driven Lifecycle

**Summarization is a slot-level server operation, not client-driven.** When the user chooses to summarize an abandoned branch:

1. Client sends `navigate_tree` command with summarization options.
2. Server responds immediately (acknowledged).
3. Server emits a session-scoped lifecycle event (navigation/summarization start).
4. Server runs the LLM summarization, switches the branch, emits completion event, then full resync with new messages.
5. Summarization keeps the slot alive — not idle-reaped, not garbage collected, even if the client disconnects.
6. On reconnect, the server informs the client of in-progress summarization so it can show the right loading state.

This matches pimote's existing pattern where the server owns session operations and the client observes via events.

### Full Tree Data Transfer

**Send the complete tree on `get_tree`, no pagination.** Tree nodes are lightweight (entry type, id, parentId, text preview, label info — not full message content). Optimize to paginated loading only if performance becomes a real problem.

### When in Doubt, Emulate the TUI

**The TUI `/tree` is the reference implementation.** For any ambiguous UI, behavioral, or interaction design question not explicitly addressed here, match what the TUI does. This includes selection behavior (user messages go to editor, non-user messages set leaf), the three-option summarization prompt, filtering modes, search behavior, active path highlighting, and node display formatting.

## Direction

### Feature Set (Full TUI Parity)

- **Tree visualization** — collapsible list showing branch structure with entry type, preview text, timestamps
- **Navigation** — select any entry to switch branch point. User messages populate the input bar for re-submission; non-user messages set the leaf directly.
- **Branch summarization** — three options on branch switch: no summary, summarize (default prompt), summarize with custom prompt. Custom prompt via a text input/editor.
- **Labels** — set/clear labels on any node. Interaction pattern TBD during design (likely tap-to-edit or context menu, designed for both touch and mouse).
- **Filtering** — modes: default (hide labels/custom), user-only, all entries, labeled-only. Exposed as a dropdown or segmented control at the top of the tree view.
- **Text search** — search input to filter tree entries by content.
- **Active path highlighting** — visual distinction for the path from root to current leaf.
- **Current leaf indicator** — clear marker on the active leaf node.

### Protocol Additions

- **`get_tree` command** — client requests full tree structure for a session. Server returns serialized `SessionTreeNode[]` with entry data, labels, and children.
- **`navigate_tree` command** — client sends target entry ID plus summarization options (skip / summarize / summarize with custom instructions). Server executes `navigateTree()` and manages the lifecycle.
- **Tree navigation lifecycle events** — session-scoped events for navigation start (with summarization in progress) and navigation end. These are buffered/replayed like other session events.
- **Reconnect awareness** — resync path includes tree navigation state so reconnecting clients can show "summarization in progress."

### Layout

- **Desktop** — tree opens as a modal/overlay, sized generously. Filter controls and search at the top, scrollable tree below, action buttons at the bottom.
- **Mobile** — tree opens full-screen (or near-full-screen). Same structure, touch-optimized sizing. Collapsible nodes respond to tap.

## Open Questions

- Exact label editing interaction pattern (inline edit, popover, context menu) — decide during UI design.
- Whether the tree modal should be dismissible by tapping outside (mobile) or only via explicit cancel.
- Loading/error states for the `get_tree` call on very large sessions.
