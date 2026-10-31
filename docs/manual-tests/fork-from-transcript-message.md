# Manual Testing — fork-from-transcript-message

## Smoke Suite

This run covers the primary session journey and the branch-navigation subset of
shared observers. Folder dashboard surfaces, voice, downloads, and Android are
outside this topic and are skipped.

- Connect to a seeded session and render its transcript. This confirms the
  feature has a usable entry surface. Driver: `agent-browser` against a real
  local Pimote server.
- Exercise transcript navigation from user and assistant faces, including redo,
  compaction, branch entry, sticky preview, mobile jump-up, and find controls.
  Driver: `agent-browser` against the real PWA.
- Open `/tree`, inspect and operate the branch explorer, then resume a selected
  message. Driver: `agent-browser` against the real PWA and a direct WebSocket
  probe for request assertions.
- Verify two observers resync after navigation and that abandoned branches stay
  visible. Driver: two WebSocket clients plus the real PWA where practical.

## Topic-Specific Tests

- **Face action menus:** user and assistant faces show `Redo from here` as a
  one-click action; `Redo with compaction…` opens a modal; empty and non-empty
  prompts send the expected navigation options; `View existing branches (N)`
  appears only at branch points. Manager and read-only transcripts hide all
  navigation actions.
- **Redo editor text:** a user-message redo returns its editor text to the
  composer; an occupied draft follows the draft-conflict policy. A successful
  navigation keeps the same session and retains the abandoned branch.
- **Sticky previous-user preview:** desktop shows one truncated previous-user
  line once the message leaves the viewport, detaches at the threshold, replaces
  itself with the next older user message, and exposes the same action menu.
  Mobile hides the sticky preview and shows the jump-up control instead.
- **Conversation find:** Ctrl/Cmd+F opens and focuses the bar; conversation
  matches show a count, cycle in both directions, highlight the active row, and
  close through the close button or Escape. Tool/thinking text is not searched.
- **Branch explorer entry:** `/tree` opens the explorer. Focused open from
  `View existing branches` selects the source message. The map shows indented
  message rows, collapsed `[…]` segments, and no branch metadata chip.
- **Branch explorer interaction:** segment expand/collapse works independently;
  anchor-first search excludes hidden messages until the explicit full-text
  fallback; fallback exposes and selects the exact message; label add/edit and
  empty-label clear persist; resume works with no compaction and with empty or
  non-empty compaction; cancellation leaves the explorer open.
- **Lifecycle and retirement:** navigation busy/resync closes the explorer only
  after the expected resync; a second observer receives the same transcript;
  manager/read-only sources suppress navigation; no retired `fork` command,
  `TreeDialog`, or dead production references remain.

## Tools

- Reused: `tools/manual-test/lib/sandbox.mjs`,
  `tools/manual-test/lib/session-dir.mjs`, `tools/manual-test/lib/browser.mjs`,
  and the `agent-browser` skill.
- New: none. The run uses direct shell/WebSocket probes and the existing browser
  driver instead of a topic-specific one-shot tool.

## Harness Limitations

The local session uses fabricated pi JSONL data and no live LLM, so this run
checks settled transcript rendering, wire navigation, and resync behavior but
cannot expose live token-stream timing, real provider compaction quality, or
network-load races. Two independent WebSocket observers exercise fan-out and
resync, but browser-level multi-observer rendering is not load-tested. These
limits weaken only live-model quality and stress coverage; the topic's primary
navigation and explorer behaviors remain exercised against the real server and
PWA.

## Results

### Smoke Suite

- **Connect and open a session — pass.** Built the workspaces, booted a real
  local Pimote, opened the seeded project session with `agent-browser`, and
  rendered the transcript. The desktop transcript and composer look coherent.
- **Prompt/session navigation surface — pass.** Exercised the settled transcript
  with user and assistant entries. The menu order and composer placement match
  the approved transcript mock. The seeded fixture has no live model stream.
- **Slash/tree navigation — pass.** Sent `/tree` through the real InputBar,
  opened the branch explorer, and resumed a selected message. The explorer
  frame, footer, and transcript resync look coherent.
- **Shared session observers — pass.** Two `WsProbe` observers opened the same
  session. One navigated to `a2-alt`; both received tree lifecycle and full
  resync events, converged on the same active messages, and retained `a6-main`
  in the tree. The observer state looks coherent.

### Topic-Specific Tests

- **Face menus and branch gating — pass.** User and assistant faces exposed
  `Redo from here` and `Redo with compaction…`. `View existing branches (1)`
  appeared on `u2` only. Linear `u1` and assistant messages without alternates
  did not show the branches item. Assistant Copy and Read aloud stayed present.
- **Redo and editor text — pass.** One-click user redo sent `navigate_tree`
  without compaction and restored the selected user text to the composer. A
  non-empty draft opened the conflict dialog; Replace installed the selected
  text. The same session stayed open and the abandoned branch remained visible.
- **Compaction choices — pass.** The empty prompt sent `summarize: true` with no
  custom instructions. The non-empty prompt sent `summarize: true`,
  `customInstructions`, and `replaceInstructions: false`. Cancel sent no
  navigation command. Successful model summarization is environment-bounded;
  the no-model response stayed visible as an explorer error.
- **Sticky preview and mobile jump — pass.** On desktop the sticky line showed
  the previous user message, switched to the next older user at the viewport
  threshold, and detached at strict equality. Its avatar opened the shared menu.
  At 500px width the preview disappeared and `Jump to previous message` moved
  the transcript upward to the prior user entry. The layout looks coherent.
- **Conversation find — pass.** Ctrl/Cmd+F opened and focused the bar. `cursor`
  reported seven matches; Next and Previous changed the active transcript row.
  Close and Escape removed the bar and cleared the query. The highlighted row
  and count look coherent. Non-conversation exclusion remains covered by the
  automated `conversation-find` suite because this fixture has no tool/thinking
  blocks.
- **Branch explorer entry and focus — pass.** `/tree` opened the full map.
  `View existing branches (1)` reopened it with `u2` selected. The map used
  indentation alone, showed collapsed `[…]` segments, and displayed no branch
  metadata chip. The explorer looks coherent against the approved mock.
- **Explorer expand/collapse and search — pass.** Expanding
  `segment:u1:u2` exposed only that run; the deeper `segment:a2-main:a6-main`
  stayed folded. Anchor search for hidden `focused server tests` showed the
  explicit fallback. Search all messages expanded and selected `u5-main`, with
  scope `all messages · 1`.
- **Explorer labels and resume — pass.** Added `focused-test` to `u5-main`,
  then cleared it with an empty input. Resume without compaction closed the
  explorer, resynced, and restored the selected user text. Custom compaction
  opened the modal; a non-empty submission sent the expected command and kept
  the explorer open when the model was unavailable. Cancel left the explorer
  open. The footer states look coherent.
- **Manager/read-only guards — fixed-inline / pass.** A seeded manager session
  initially exposed redo actions. `MessageList` now identifies manager sessions
  from the manager root and manager persona metadata, suppresses tree loading,
  sticky navigation, and redo actions, and keeps Copy/Read aloud. Rebuilt and
  reloaded the PWA; manager user faces became non-interactive and the assistant
  menu had no navigation items. Read-only menu suppression passed through the
  existing rendered component tests; the live read-only surface is inside the
  skipped voice mode.
- **Retirement checks — pass.** No production `ForkCommand`, wire `fork` case,
  `TreeDialog`, or tree-dialog store references remain. `tree-dialog-utils` is
  retained only as the shared pure label helper. The remaining `type: 'fork'`
  occurrence is a negative test assertion.

## Plan Updates

Empty. This topic changes an existing journey but does not add a new primary
journey to the persistent plan.

## Open Issues

- A successful LLM-generated branch summary was not observed because the
  sandbox has no configured model and the local SGLang endpoint is unavailable.
  Modal dispatch, cancellation, error retention, and wire options passed.
  Repeat the compaction-success click path with a reachable model before a
  release that claims provider-level summary quality.
