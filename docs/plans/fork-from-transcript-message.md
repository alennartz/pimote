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
  load(sessionId: string): Promise<GetTreeResponseData | null>; // lazy fetch, cached
  open(sessionId: string, snapshot?: GetTreeResponseData): Promise<void>;
  openFocused(sessionId: string, entryId: string, snapshot?: GetTreeResponseData): Promise<void>;
  close(): void;
  toggleSegment(segmentId: string): void;
  select(entryId: string): void;
  setSearch(query: string): void; // visible anchors: conversation text and labels
  searchAll(query: string): void; // all conversation text and labels; expose/select matches
  /** navigate_tree; empty prompt → summarize:true (default summarization —
   *  revises the brainstorm's custom-only rule, decided during architecting),
   *  non-empty → summarize + customInstructions (replaceInstructions: false),
   *  called without compaction for one-click redo. */
  navigate(entryId: string, opts?: { compactionPrompt?: string }): Promise<{ cancelled: boolean; editorText?: string } | null>;
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
  `manager`, `readOnly`, and a store with `navigate`/`openFocused`. It also accepts
  optional `onRedo(entryId, opts)` for transcript-owned draft handling. Without
  that callback, it dispatches through the store. Restricted sources hide navigation.
- `load` reads the snapshot without opening the explorer. Transcript menus derive
  alternate counts from the loaded state. Optional snapshots on `open` and
  `openFocused` seed the cache without another read.
- `navigate` returns the navigation result, or null on failure with `state.error`
  set. MessageList applies the draft conflict policy to `editorText`.
  BranchExplorer preserves TreeDialog's `sessionRegistry.setDraftText` behavior.
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

## Steps

**Pre-implementation commit:** `3be1072747aced1635442fbfe441ce930c8d5ef8`

### Step 1: Transfer complete conversation trees

In `server/src/ws-handler.ts`, enrich `mapTreeNodes` with `conversationText`
only for user and assistant message entries. Reuse text extraction from
`previewForEntry`, join text blocks with `\n\n`, and exclude thinking and tools.
Keep preview truncation unchanged. Extend `serializeTreeResponse` to emit the
optional field without changing its iterative traversal.

Add a shared tree-response handler used by `dispatchPimoteSlashCommand` and the
`get_tree` session-command case. Return `GetTreeResponseData` with the current
leaf. Keep observer access consistent with existing tree reads.
`shared/src/protocol.ts` already contains the additive interface declarations.

**Verify:** Run `npm run test --workspace=server -- --run src/ws-handler.test.ts -t "tree navigation interfaces"`. Conversation text, direct reads, slash reads, and deep-tree tests pass.
**Status:** done

### Step 2: Implement branch projection

Implement `buildBranchMap`, `segmentsToExpose`, and `abandonedBranchCountAt` in
`client/src/lib/branch-tree.ts` behind the existing row interface.
Project user and assistant messages only. Preserve conversation descendants of
omitted internal and tool nodes. Render shared messages once, preserve tree order,
and mark active ancestry from `currentLeafId`.

Classify branch points by meaningful continuations. Fold linear runs into first
and last anchors with a segment row counting only hidden messages. Segment
identities must remain stable across projection, expansion, and focus operations.
Expanding one run must not expand deeper runs. Expose hidden focus targets without
expanding unrelated segments. Report logical depth without a responsive cap.
Keep all topology calculations pure. Reuse traversal ideas from
`client/src/lib/tree-dialog-utils.ts`, without duplicating topology in rendering.

**Verify:** Run `npm run test --workspace=client -- --run src/lib/branch-tree.test.ts`. All projection, focus, exclusion, depth, and alternate-count cases pass.
**Status:** done

### Step 3: Implement transcript search and target selection

Implement `findInConversation` in `client/src/lib/conversation-find.ts`.
Return case-insensitive text matches in transcript and block order. Preserve original
block indices, offsets, and match lengths. Use message entry identity when present.
Only search user and assistant text blocks. Empty queries return no matches.

Implement `previousUserAbove` in `client/src/lib/transcript-navigation.ts`.
Return the last user entry with bottom strictly below the viewport's numeric
cutoff, `viewportTop + threshold`. Equality detaches the preview. Return null
when no user qualifies. Do not include DOM access in either module.

**Verify:** Run `npm run test --workspace=client -- --run src/lib/conversation-find.test.ts src/lib/transcript-navigation.test.ts`.
**Status:** done

### Step 4: Implement snapshot and explorer state

Implement `BranchTreeStore` in
`client/src/lib/stores/branch-tree-store.svelte.ts`. Add the approved `load` seam,
optional snapshot parameters, and navigation-result return type from Interfaces.
Keep transport injected. The store owns the per-session cache and navigation
lifecycle state previously held by TreeDialog.

`load` fetches only an uncached session and publishes its snapshot without opening
the explorer. `open` resets explorer interaction state and reads through `load`,
or seeds the cache from its supplied snapshot. `openFocused` selects the exact
entry and expands `segmentsToExpose`. Implement close, selection, and segment
toggling with reactive state.

Use `buildBranchMap` for anchor search eligibility. Match conversation text and
labels by exact message identity. `searchAll` includes hidden conversation entries,
exposes matching segments, and selects a matching entry. Keep label matches at
message identity rather than inventing conversation-block offsets.

`navigate` sends no compaction fields for one-click redo. An explicit empty prompt
sends `summarize: true`. A non-empty prompt also sends `customInstructions` and
`replaceInstructions: false`. Return the result without applying composer policy.
Unsuccessful responses and rejected promises return null, set error, and keep
the explorer open. Cancellation must not trigger successful close behavior.

`setLabel` sends `set_tree_label`, normalizes empty labels to undefined, and updates
the cached snapshot after success. Reuse `updateTreeNodeLabel` from
`client/src/lib/tree-dialog-utils.ts`. Subscribe to transport events once.
Invalidate the matching session cache on every full resync. Move start/end busy
tracking and close-on-resync handling from TreeDialog, keeping sessions isolated.

**Verify:** Run `npm run test --workspace=client -- --run src/lib/stores/branch-tree-store.svelte.test.ts`. Cache, focus, search, labels, options, lifecycle, and both failure modes pass.
**Status:** done

### Step 5: Build shared message actions

Implement `client/src/lib/components/MessageActionMenu.svelte` with the approved
props. Render both redo buttons for navigation-capable sources. Show
`View existing branches (N)` only for positive alternate counts. Hide navigation
for manager and read-only sources. One-click redo dispatches immediately without
confirmation or compaction. Use `onRedo` when supplied, otherwise store navigation.
Focused branch opening calls `openFocused(sessionId, entryId)`.

Implement the compaction modal with textarea, Cancel, and OK. Cancel and dismissal
must not navigate. OK passes the entered prompt, including an empty string.
Preserve existing Copy and TTS controls through optional menu content or props.
Keep the navigation props usable by the existing component tests.

Update `client/src/lib/components/Message.svelte` to use this menu on user and
assistant faces. Replace `onfork` with transcript redo integration props. Allow
navigation for persisted assistant entries even without speakable text. Preserve
Copy/TTS availability rules, tool rendering, costs, and streaming behavior.
Use existing dialog and button modules rather than adding dependencies.

**Verify:** Run `npm run test --workspace=client -- --run src/lib/components/MessageActionMenu.test.ts`. Check both face menus and modal cancellation against `docs/mocks/fork-from-transcript-message/transcript.html`.
**Status:** done

### Step 6: Build the branch explorer

Create `client/src/lib/components/BranchExplorer.svelte` around `branchTreeStore`
and `buildBranchMap`. Follow `tree-explorer.html`: large frame, indented message
rows, collapsed-message chips, active-path styling, selection, and resume footer.
Compress indentation responsively without horizontal scrolling. Expanded segments
need a collapse affordance even though expanded projection omits their segment row.
Keep that affordance keyed to store segment identities.

Render label chips and an add-label action. Inline editing commits on Enter or
blur, cancels on Escape, and clears empty input. Call store `setLabel`; retain
errors without losing the selection. Reuse the retained tree utilities for pure
label updates and path/filter needs rather than copying their implementations.

Wire anchor search, scope/count display, highlighted message hits, and an explicit
Search all messages fallback. Focused opens and full-search hits scroll to the
exact selected message after rendering. Disable resume without a message selection
or while busy. Resume without compaction calls `navigate(selectedId)`.
Compaction opens the opt-in modal with Cancel and OK, using the same prompt rules
as transcript redo. Apply successful non-cancelled `editorText` through
`sessionRegistry.setDraftText(sessionId, editorText)`, preserving TreeDialog behavior.

Close on Escape, dismissal, or viewed-session changes. Keep lifecycle handling in
the store, not the explorer. Show load/navigation errors inside the open frame.

**Verify:** Check collapsed/expanded runs, focused opens, inline label clearing, anchor/full search, resume, cancellation, busy/error states, and narrow layouts against `docs/mocks/fork-from-transcript-message/tree-explorer.html`.
**Status:** done

### Step 7: Integrate transcript redo and sticky navigation

Replace `handleFork` in `client/src/lib/components/MessageList.svelte` with an
`onRedo` callback. Bind navigation to the viewed regular session, retaining the
`source` and `readOnly` guards. Call store navigation and use returned `editorText`
with existing `needsDraftPrompt`, `applyDraftChoice`, and draft-choice dialog.
Use the same session ID after navigation, not new-session replacement semantics.
Do not apply editor text for null or cancelled results. Update fork wording.

Load snapshots without opening the explorer for navigation-capable message menus.
Derive alternate counts reactively through `abandonedBranchCountAt`, so menus gain
the branches item when data arrives. Refresh after cache invalidation without
fetching for manager or read-only sources.

Create `client/src/lib/components/StickyUserPreview.svelte`. Render a desktop-only,
one-line truncated user preview with avatar and the same MessageActionMenu and
`onRedo`. MessageList gathers rendered message positions and calls
`previousUserAbove` on scroll and layout changes. Attach message keys to scrollable
rows without changing message rendering. Hide the preview when no target qualifies.
On mobile, hide the preview and add jump-up scrolling to the previous user message.
Preserve the existing bottom-scroll and abort controls.

**Verify:** Existing draft-policy tests pass. Check redo on both roles, occupied-draft choices, sticky threshold detachment, older-target replacement, mobile jump-up, and unchanged bottom-follow behavior against `transcript.html`.
**Status:** done

### Step 8: Integrate conversation find controls

Implement `client/src/lib/components/ConversationFindBar.svelte` with its existing
matches, onMatch, and onClose props. Add query binding needed by MessageList without
breaking those props. Show match count and accessible Next match and Previous match
buttons. Cycle in both directions and do nothing for empty results.

Host the bar in `MessageList.svelte`. Ctrl/Cmd+F opens and focuses it; Escape closes
it and clears the find state. Search the current active transcript with
`findInConversation`. Map entry identities to existing transcript message keys when
scrolling. Scroll to each reported match and mark its row or text visibly. Keep
search out of tool/thinking/system/custom content. Remove keyboard and layout
listeners when the transcript unmounts.

**Verify:** Run `npm run test --workspace=client -- --run src/lib/components/ConversationFindBar.test.ts`. Check keyboard opening/closing, count changes, cycling, visible marking, and scroll anchoring against `transcript.html`.
**Status:** done

### Step 9: Switch entry paths and retire old surfaces

In `client/src/lib/components/InputBar.svelte`, replace treeDialogStore references
with branchTreeStore. Both existing tree-response paths call
`open(sessionId, { tree, currentLeafId })`, preserving the supplied snapshot without
another request. Update slash-menu and Escape guards to the new open state.
In `client/src/routes/+layout.svelte`, replace TreeDialog with BranchExplorer.

Remove `ForkCommand` and its union member from `shared/src/protocol.ts`. Remove
the server fork command case and its routing entry in `server/src/ws-handler.ts`.
Update protocol comments that describe message entry IDs as fork targets.
Leave pi's `commandContextActions.fork` and SDK extension behavior unchanged.

Delete `client/src/lib/components/TreeDialog.svelte` and
`client/src/lib/stores/tree-dialog.svelte.ts`. Retain
`client/src/lib/tree-dialog-utils.ts` and its tests for reusable pure helpers.
Retire `TreeDialog.test.ts`, `stores/tree-dialog.svelte.test.ts`, and the
`describe('fork command')` suite in `server/src/ws-handler.test.ts` with fork-only
fixtures. These deletions retire the removed feature contracts.

In the live `client/src/lib/components/InputBar.dispatch.test.ts`, change only the
store import, cleanup call (`closeDialog` to `close`), and tree-state references.
Keep its behavioral assertions unchanged. These migrations and retired-suite
removals are the approved exceptions. Do not change any other existing tests.

**Verify:** Run the complete client and server suites with `npm run test --workspace=client -- --run` and `npm run test --workspace=server -- --run`, then `npm run check`. Confirm no production caller sends wire `fork` or imports the retired tree dialog/store. Complete the approved manual checks from Steps 5–8.
**Status:** done
