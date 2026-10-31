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

_To be filled while the smoke and topic-specific tests run._

## Plan Updates

Empty. This topic changes an existing journey but does not add a new primary
journey to the persistent plan.

## Open Issues

_To be filled after execution._
