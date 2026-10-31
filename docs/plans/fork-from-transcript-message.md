# Plan: fork-from-transcript-message

## Context

Branch-aware transcript navigation: the transcript becomes the primary surface for
linear navigation and redo-from-a-message; `/tree` becomes the branch explorer for
recovering abandoned branches. Server-side semantics already work — pi owns them —
so this is a UX-first change with two small protocol additions. See
[brainstorm](../brainstorms/fork-from-transcript-message.md) and the approved mocks
in `docs/mocks/fork-from-transcript-message/` (the interaction contract).

## Architecture

### Core decision: tree navigation is the only branching primitive

Every redo and resume flow — transcript menu, branch explorer, focused
"View existing branches" — goes through `navigate_tree` (same session file, leaf
pointer moves, abandoned branch retained in the session tree). Pi's new-session
`fork` is retired from the Pimote wire: it splits history into separate session
files that the branch explorer cannot see, and it has no compaction option.

Consequences already supported by the wire: `tree_navigation_start`/`end` events,
full resync, `set_tree_label`, custom compaction options, and `editorText`
(user-message target text) which feeds the composer with the existing draft
conflict policy.

### Impacted Modules

**Protocol** — Two additive/contract changes:

- `PimoteTreeNode` gains optional `conversationText: string` — full user- and
  assistant-authored text for message nodes (blocks joined `\n\n`). Absent for
  tool, bookkeeping, and other non-message entries. This deliberately revises
  DR-007's preview-only rule: snapshots stay one-shot and metadata-shaped, and
  text-only enrichment keeps them small (worst case a few MB at 1M context; tool
  results and thinking are excluded).
- New `get_tree` command `{ type: 'get_tree' }` → `{ tree, currentLeafId }`,
  sharing the response shape the `/tree` prompt interception already returns. It
  gives the client a direct read for lazy fetch and explorer refresh.
- `ForkCommand` and the server `fork` case are removed (no remaining caller).
  The SDK/pi extension `commandContextActions.fork` surface is pi's, untouched.
- Android does not consume tree or fork vocabulary; the additive optional field
  needs no mirror change.

**Server** — `mapTreeNodes` populates `conversationText` for user/assistant
message entries (reusing its text extraction); `serializeTreeResponse` emits it.
The `/tree` prompt interception and the new `get_tree` case share one handler
seam. The `fork` case is deleted.

**Web Client** — The bulk of the work:

- `Message.svelte`: the face menu becomes a shared action menu. Assistant face
  gains the same navigation items alongside existing Copy/TTS.
- `MessageList.svelte`: the fork flow is replaced by the redo flow; hosts the
  sticky preview and find bar.
- `TreeDialog.svelte` + `tree-dialog` store + `tree-dialog-utils`: replaced by
  the branch explorer built on a new pure projection module.
- `InputBar.svelte`: `/tree` interception stays; both entry paths share the
  server seam.

### New Modules

- `client/src/lib/branch-tree.ts` — pure projection from `PimoteTreeNode[]` to
  the explorer's row model. Owns: branch-point classification (≥2 continuations),
  collapsed segments (linear runs fold to first/last anchors + `[…] N messages`),
  shared fork-point messages rendered once, active-path marking, depth computation
  with a mobile cap (no horizontal scrolling), and focus resolution. Deep module:
  all topology reasoning behind three functions.
- `client/src/lib/conversation-find.ts` — pure search over active-branch
  conversation text (user + assistant text blocks only; no tool/thinking/system/
  custom content). Returns ordered matches with message key, block index, offset,
  length.
- `client/src/lib/stores/branch-tree-store.svelte.ts` — explorer + snapshot
  state: lazy fetch with per-session cache, expanded segments, selection, search
  scope (anchors → all messages), resume action. Replaces the `tree-dialog` store
  and its navigation-state event handling (which moves here).
- `client/src/lib/components/MessageActionMenu.svelte` — the one menu shared by
  message faces and the sticky preview: **Redo from here** (always, one click, no
  compaction), **Redo with compaction…** (modal: empty prompt → pi's default
  summarization, non-empty → custom instructions), **View existing branches (N)**
  (only when `abandonedBranchCountAt > 0`), plus existing Copy/TTS items.
  The empty-prompt rule deliberately revises the brainstorm's custom-only
  compaction decision: opening the compaction modal is itself the opt-in, and an
  empty prompt means pi's default summarization (user decision during
  architecting).
- `client/src/lib/components/BranchExplorer.svelte` — the `/tree` surface per
  mock: large frame, indented tree, segment expand/collapse, label chips with
  inline edit (`set_tree_label`), anchor-first search with explicit full-text
  fallback button, resume footer with opt-in compaction modal.
- `client/src/lib/components/ConversationFindBar.svelte` — find bar per mock.
- `client/src/lib/components/StickyUserPreview.svelte` — desktop one-line
  previous-user-message preview carrying `MessageActionMenu`.

### Interfaces

```ts
// shared/src/protocol.ts
interface PimoteTreeNode {
  // existing fields…
  /** Full user/assistant text (blocks joined \n\n). Message nodes only. */
  conversationText?: string;
}
interface GetTreeCommand extends CommandBase {
  type: 'get_tree';
}
// resp: { tree: PimoteTreeNode[]; currentLeafId: string | null }
```

```ts
// client/src/lib/branch-tree.ts
type BranchMapRow =
  | { kind: 'message'; id: string; role: string; text: string; label?: string;
      isActive: boolean; isBranchPoint: boolean; depth: number }
  | { kind: 'segment'; id: string; firstId: string; lastId: string;
      hiddenCount: number; depth: number };

buildBranchMap(tree: PimoteTreeNode[], currentLeafId: string | null,
  expandedSegmentIds: ReadonlySet<string>): BranchMapRow[];
/** Segment ids to expand so `targetId` renders (focused open, search fallback). */
segmentsToExpose(tree: PimoteTreeNode[], targetId: string): Set<string>;
/** Alternate continuations at a message; 0 when it is not a branch point. */
abandonedBranchCountAt(tree: PimoteTreeNode[], entryId: string): number;
```

```ts
// client/src/lib/conversation-find.ts
interface FindMatch { messageKey: string; blockIndex: number; offset: number; length: number }
findInConversation(messages: readonly PimoteAgentMessage[], query: string): FindMatch[];
```

```ts
// client/src/lib/stores/branch-tree-store.svelte.ts
class BranchTreeStore {
  open(sessionId: string): Promise<void>; // lazy fetch, cached
  openFocused(sessionId: string, entryId: string): Promise<void>;
  close(): void;
  toggleSegment(segmentId: string): void;
  select(entryId: string): void;
  setSearch(query: string): void; // visible anchors: conversation text and labels
  searchAll(query: string): void; // all conversation text and labels; expose/select matches
  /** navigate_tree; empty prompt → summarize:true (default summarization —
   *  revises the brainstorm's custom-only rule, decided during architecting),
   *  non-empty → summarize + customInstructions (replaceInstructions: false),
   *  called without compaction for one-click redo. */
  navigate(entryId: string, opts?: { compactionPrompt?: string }): Promise<void>;
  setLabel(entryId: string, label: string | undefined): Promise<void>;
}
```

Store contracts: unsuccessful responses and rejected transport promises from open or
navigate set `state.error` and keep the explorer open. Search matches use message
entry identity. Label hits identify the labeled message, not a conversation block.
The transcript `findInConversation` seam remains conversation-text-only.
Cache invalidates on that session's `full_resync`;
`tree_navigation_start`/`end` set busy state and close-on-resync behavior (moved
from TreeDialog); manager and read-only transcript sources suppress navigation
actions (existing `MessageList` guard pattern).

Transcript redo flow: menu → `navigate(entryId)` or `navigate(entryId, { compactionPrompt })`
→ on success, `editorText` routes through the draft conflict policy
(`needsDraftPolicy`/`applyDraftChoice`) into the composer draft.

Sticky preview contract: renders the last user message above the transcript
viewport as one truncated line + avatar with `MessageActionMenu`; hidden while
that message is within the viewport threshold, then the next-older user message
takes over. Mobile: hidden entirely; the jump-up button scrolls to the previous
user message instead.

Find bar contract: Ctrl/Cmd+F opens, Esc closes; match count shown; next/previous
cycles matches; the transcript scrolls to each match and marks it visibly
(rendering technique — inline mark or row highlight — is implementation freedom).

### Interaction Mocks

- `docs/mocks/fork-from-transcript-message/index.html` — overview of what each surface settles.
- `docs/mocks/fork-from-transcript-message/transcript.html` — face menus, one-click redo, compaction modal, conditional branches item, sticky preview, mobile toggle, find bar.
- `docs/mocks/fork-from-transcript-message/tree-explorer.html` — branch map, segment expansion, labels, anchor-first search with fallback, resume footer with compaction modal.

### Review-added interaction interfaces

- `MessageActionMenu` accepts `entryId`, `sessionId`, `abandonedBranchCount`,
  `manager`, `readOnly`, and a store with `navigate`/`openFocused`. Its buttons
  dispatch navigation for the selected entry. Restricted sources hide navigation.
- `ConversationFindBar` accepts `matches`, `onMatch`, and `onClose`. Accessible
  Next match and Previous match buttons cycle through results and report the target.
- `transcript-navigation.ts` exports `previousUserAbove(positions, viewportTop,
threshold = 0)`. Positions contain `entryId`, `role`, and `bottom` in transcript
  order. It returns the last user whose bottom is strictly above viewportTop +
  threshold, or null. Equality detaches the preview.
- Branch projection exposes logical depth. Responsive depth compression belongs
  to rendering, not projection.

### DR Supersessions

- **DR-007** (Server-owned tree navigation lifecycle and full snapshot transfer) —
  its preview-only content rule is revised: message tree nodes now carry full
  conversation text. The server-owned lifecycle and full-snapshot decisions stand.
- New decision (no prior DR exists): tree navigation is the sole branching
  primitive; the new-session `fork` wire command is retired.

## Tests

**Pre-test-write commit:** `d79490ed2436c8f3ce9e38d76bbab8077b6fb7f9`

### Interface Files

- `shared/src/protocol.ts` — adds optional message `conversationText`, the `get_tree` command, and its response shape.
- `client/src/lib/branch-tree.ts` — defines the branch-map row model and projection seams.
- `client/src/lib/conversation-find.ts` — defines the conversation search match shape and search seam.
- `client/src/lib/stores/branch-tree-store.svelte.ts` — defines the explorer transport, state, and operation seams.
- `client/src/lib/transcript-navigation.ts` — defines sticky-preview target selection.
- `client/src/lib/components/MessageActionMenu.svelte` — defines shared action-menu props.
- `client/src/lib/components/ConversationFindBar.svelte` — defines match-navigation props.

### Test Files

- `client/src/lib/branch-tree.test.ts` — covers collapsed segments, active-path projection, focus expansion, and alternate branch counts.
- `client/src/lib/conversation-find.test.ts` — covers ordered text matches and exclusion of non-conversation blocks.
- `client/src/lib/stores/branch-tree-store.svelte.test.ts` — covers lazy cache reads, focus, search state, navigation options, labels, and lifecycle invalidation.
- `server/src/ws-handler.test.ts` — covers conversation-text mapping and serialization plus the direct `get_tree` response.
- `client/src/lib/transcript-navigation.test.ts` — covers previous-user selection and threshold detachment.
- `client/src/lib/components/MessageActionMenu.test.ts` — covers visibility guards and redo dispatch.
- `client/src/lib/components/ConversationFindBar.test.ts` — covers match cycling and empty results.

### Behaviors Covered

#### Server tree transfer

- Message tree nodes carry complete user/assistant text while non-message nodes omit it.
- Serialized tree responses preserve `conversationText`.
- The `get_tree` command returns the mapped snapshot and current leaf.

#### Branch tree projection

- Linear continuations fold to first and last message anchors with a hidden-message count.
- Active-path messages are marked, and shared messages render once.
- Expanding a segment reveals that segment without forcing deeper segments open.
- Focusing a hidden message returns the segments needed to expose it.
- A branch point reports its alternate continuation count; linear and missing entries report zero.

#### Conversation search

- Case-insensitive matches are returned in transcript order with message keys, block offsets, and lengths.
- Thinking, tool, system, custom, and other non-conversation blocks are excluded.
- An empty query returns no matches.

#### Branch tree store

- The first open fetches a session tree; later opens reuse that session's cached snapshot.
- Focused opens select the requested entry and expose its collapsed segments.
- Segment expansion, selection, anchor-first search, and explicit full-text search update store state.
- One-click navigation omits compaction; empty and non-empty compaction prompts map to default and custom summarization options.
- Label changes use the tree-label command, with an empty label clearing the value.
- Full resync invalidates the session cache; tree-navigation lifecycle events update busy state and close the explorer after resync.
- Anchor search excludes collapsed messages. Full search matches conversation text and labels, exposes hidden hits, and selects exact messages.
- Open and navigate failures set an error without closing the explorer.

#### Transcript interaction

- Message menus offer both redo actions. Existing branches appear only for positive alternate counts.
- Manager and read-only sources suppress navigation actions.
- Redo dispatches the chosen entry with no compaction or the entered compaction prompt.
- Sticky target selection excludes assistants and detaches at the viewport threshold.
- Find controls cycle results in both directions and handle empty results.

#### Approved manual coverage

Explorer footer/modal cancellation, mobile layout, jump-up scrolling, responsive
depth compression, and rendered sticky/find scroll anchoring require manual checks.
User-message editorText draft-conflict handling retains its existing policy tests.
The reviewer approved this automated/manual split through the orchestrator.

**Review status:** approved
