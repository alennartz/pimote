# Plan: Tree Navigation

## Context

Bring the TUI's `/tree` session history navigation to pimote with full feature parity — tree visualization, branch navigation, summarization, labels, filtering, and search. Adapted for web with a collapsible list UI that works on both desktop and mobile. See [brainstorm](../brainstorms/tree-navigation.md).

## Architecture

### Impacted Modules

**Protocol** — New command types (`GetTreeCommand` via `/tree` prompt interception, `NavigateTreeCommand`, `SetTreeLabelCommand`), new session-scoped event types (`TreeNavigationStartEvent`, `TreeNavigationEndEvent`), and a new wire data type (`PimoteTreeNode`). All added to the existing discriminated unions.

**Server** — ws-handler gains `/tree` interception in the prompt handler (same pattern as `/new` and `/reload`), which fetches the tree from the SDK session manager, maps it to the wire format, and returns it in the command response. Two new session commands: `navigate_tree` (manages the navigation + summarization lifecycle with events and idle-reap protection) and `set_tree_label` (calls `appendLabelChange` on the session manager). session-manager gains a `treeNavigationInProgress` flag on `SessionState` that the idle check respects.

**Client** — New `TreeDialog.svelte` component mounted in the layout, driven by a reactive tree dialog store. Collapsible list with search, filtering, label editing, and a summarization prompt flow. On navigation completion, the input bar is populated with `editorText` if present, and the full resync updates the message list.

### Interfaces

#### Wire Types (Protocol)

```typescript
// Tree node for wire transfer — slim preview, no full message content
interface PimoteTreeNode {
  id: string;
  type: string; // 'message' | 'compaction' | 'branch_summary' | 'custom' | 'custom_message' | 'label' | ...
  role?: string; // for message entries: 'user' | 'assistant' | 'custom'
  customType?: string; // for custom/custom_message entries
  preview: string; // truncated text preview (~200 chars)
  timestamp: string; // ISO 8601
  label?: string; // resolved label if any
  labelTimestamp?: string; // timestamp of latest label change
  children: PimoteTreeNode[];
}
```

```typescript
// Client → Server: navigate to a tree node
interface NavigateTreeCommand extends CommandBase {
  type: 'navigate_tree';
  targetId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

// Client → Server: set or clear a label on a tree entry
interface SetTreeLabelCommand extends CommandBase {
  type: 'set_tree_label';
  entryId: string;
  label?: string; // undefined or empty to clear
}
```

```typescript
// Server → Client: tree navigation lifecycle events (session-scoped, buffered)
interface TreeNavigationStartEvent extends SessionEventBase {
  type: 'tree_navigation_start';
  targetId: string;
  summarizing: boolean; // true if LLM summarization is in progress
}

interface TreeNavigationEndEvent extends SessionEventBase {
  type: 'tree_navigation_end';
}
```

#### Server: `/tree` Prompt Interception (ws-handler)

When the prompt handler receives `/tree`:

1. Call `slot.session.sessionManager.getTree()` to get `SessionTreeNode[]`
2. Call `slot.session.sessionManager.getLeafId()` to get the current leaf
3. Map `SessionTreeNode[]` → `PimoteTreeNode[]` (recursive, truncating message content to ~200 char previews)
4. Respond with `{ tree: PimoteTreeNode[], currentLeafId: string | null }`

Mapping function signature:

```typescript
function mapTreeNodes(nodes: SessionTreeNode[]): PimoteTreeNode[];
```

Extracts preview text from entry based on type:

- `message` with role `user` or `assistant`: text content truncated
- `compaction`: summary text truncated
- `branch_summary`: summary text truncated
- `custom_message`: content string truncated
- Other types: type name as preview

#### Server: `navigate_tree` Command Handler (ws-handler)

```
1. Set slot.sessionState.treeNavigationInProgress = true
2. Emit TreeNavigationStartEvent { targetId, summarizing: !!options.summarize }
3. Call session.navigateTree(targetId, options)
4. In finally block: set treeNavigationInProgress = false
5. Emit TreeNavigationEndEvent
6. If not cancelled: trigger handleSessionReset (sends full_resync)
7. Respond with { editorText?: string, cancelled: boolean }
```

#### Server: `set_tree_label` Command Handler (ws-handler)

```
1. Call slot.session.sessionManager.appendLabelChange(entryId, label)
2. Respond with { success: true }
```

#### Server: Idle Reap Protection (session-manager)

`SessionState` gains:

```typescript
treeNavigationInProgress: boolean; // initialized false
```

Idle check in `startIdleCheck` skips slots where `sessionState.treeNavigationInProgress === true`, same as it would skip a streaming session.

#### Client: Tree Dialog Store

```typescript
interface TreeDialogState {
  open: boolean;
  sessionId: string | null;
  tree: PimoteTreeNode[] | null;
  currentLeafId: string | null;
}

// Open: called when /tree prompt response arrives with tree data
// Close: called on cancel, on navigation, or when viewed session changes
// Tied to viewed session — closes if viewed session changes
```

#### Client: TreeDialog.svelte

Full-screen dialog (mobile `h-dvh`, desktop large centered modal — same pattern as extension editor dialog).

**Layout:**

- Top: search input + filter mode selector (dropdown or segmented control)
- Middle: scrollable collapsible tree list
- Bottom: action bar (Cancel, Navigate button)

**Tree list behavior:**

- Each node: expand/collapse toggle (if has children), entry type indicator, preview text, timestamp, label badge, active path marker
- Current leaf node gets a distinct marker (e.g. "← active" badge or highlight, matching TUI behavior)
- Tap to select (highlight), Navigate button to confirm — or tap selected node again to confirm
- Active path (root to current leaf) visually distinguished
- Filtering modes: default (hide label/custom entries), user-only, all, labeled-only
- Text search filters nodes by preview content
- Filter/search changes reset fold state

**Label editing:**

- Long-press (mobile) / right-click (desktop) opens a popover with text input
- Sends `set_tree_label`, updates local tree state without refetching

**Summarization prompt flow (after node selection):**

- Three options: No summary, Summarize, Summarize with custom prompt
- Custom prompt option shows a text input
- Sends `navigate_tree` with chosen options

**Post-navigation:**

- `navigate_tree` response carries `editorText`
- Dialog closes
- If `editorText` present, populate the input bar
- Full resync from server updates the message list

**Lifecycle:**

- Mounted in `+layout.svelte`
- Closes when viewed session changes
- During `tree_navigation_start` (if summarizing): shows loading indicator
- On `tree_navigation_end`: loading clears, dialog closes on next full resync

**General principle:** When in doubt on any behavioral or interaction detail not specified here, emulate the TUI `/tree` implementation.

#### Client: Reconnect with Active Tree Navigation

When reconnecting, if the event buffer replay contains a `tree_navigation_start` without a matching `tree_navigation_end`, the client shows a loading state indicating summarization is in progress. When `tree_navigation_end` arrives followed by full resync, normal state resumes.

## Tests

**Pre-test-write commit:** `0d91138b4c111387ffa9ddb4b01c574fca08bbde`

### Interface Files

- `shared/src/protocol.ts` — Added tree navigation wire contracts: `PimoteTreeNode`, `navigate_tree`, `set_tree_label`, and `tree_navigation_start`/`tree_navigation_end` session events.
- `server/src/session-manager.ts` — Extended `SessionState` with `treeNavigationInProgress` and wired idle reaper skip semantics while navigation is active.
- `server/src/ws-handler.ts` — Added `/tree` prompt interception response shape (`tree`, `currentLeafId`) and `mapTreeNodes()` mapping surface used by tree transfer.
- `client/src/lib/stores/tree-dialog.svelte.ts` — Materialized client-side tree dialog state contract (`TreeDialogState`, filter/search mode controls, selection/loading lifecycle) with method stubs for filtering/label updates.

### Test Files

- `server/src/ws-handler.test.ts` — Added behavioral tests for `/tree` data mapping, `navigate_tree` lifecycle flow, and `set_tree_label` delegation contract.
- `server/src/session-manager.test.ts` — Added idle-reaper tests for `treeNavigationInProgress` protection and post-navigation reaping.
- `client/src/lib/stores/tree-dialog.svelte.test.ts` — Added tree dialog store behavioral tests for open/close lifecycle, fold-state reset, filtering expectations, and local label updates.

### Behaviors Covered

#### Server: Tree Query + Navigation Commands

- `/tree` prompt returns mapped session tree nodes with preview text, label metadata, and current leaf id.
- `navigate_tree` forwards target and summarization options to the session and should emit start/end lifecycle events around navigation.
- `navigate_tree` should trigger a full resync on successful navigation and return `{ cancelled, editorText? }` for input-bar population.
- `set_tree_label` delegates label updates to `sessionManager.appendLabelChange(entryId, label)` and responds with success.

#### Server: Idle Reaping During Navigation

- Sessions past idle timeout are not reaped while `treeNavigationInProgress === true`.
- Once navigation finishes (`treeNavigationInProgress` flips false), stale sessions become reaped on the next idle check.

#### Client: Tree Dialog Store Contract

- Opening `/tree` data initializes a session-scoped dialog state and selects the active leaf.
- Changing filter mode or search query resets fold state.
- Default filtering excludes label/custom entries while keeping conversational message history.
- Label edits are applied locally so tree UI can update immediately without a refetch.
- Closing the dialog clears session-scoped tree state and loading/selection flags.
