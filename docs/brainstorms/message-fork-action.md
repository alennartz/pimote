# Brainstorm: Message-level Fork Action

## Idea

Add a per-message fork action in the chat UI, shown as a circular button in the message action stack (under the existing robot-icon menu pattern), so users can fork directly from message context instead of typing `/fork` and selecting from a separate list.

## Key Decisions

- **Expose fork on user messages only.**
  - We considered parity on assistant messages too, but chose to match TUI semantics where fork targets user messages.
  - This avoids ambiguous mapping from assistant turns to fork targets.

- **Use existing icon-triggered affordance pattern.**
  - Fork should be accessed by clicking the **user icon** to reveal a small vertical tool menu (same interaction style as assistant TTS menu).
  - We explicitly did not choose an always-visible button to keep visual noise low.

- **Fork behavior is immediate (no pre-confirm).**
  - Clicking fork directly performs fork + session switch, matching `/fork` mental model.

- **Input restoration matches TUI by default.**
  - After fork, default behavior is to set editor input to the selected user message text (same spirit as TUI’s selectedText restoration).

- **Add conflict handling when draft input exists.**
  - If input is empty, restore forked text directly.
  - If input already has content, present choices:
    - **Replace**
    - **Append**
    - **Prepend**
    - **Ignore**
  - **Ignore** means: fork still happens, but current draft input remains unchanged.

- **Skill block behavior follows stored turn text.**
  - We validated TUI behavior: fork restoration uses selected user turn text as returned by fork flow.
  - Therefore, if a user turn includes expanded skill content, that text is what gets restored.

## Direction

Implement a message-level user-turn fork action that preserves TUI fork semantics while adding web-specific guardrails for draft text collisions. Keep interaction lightweight (icon + mini menu), deterministic (user messages only), and session-reset-safe (fork triggers normal session replacement flow).

## Open Questions

- None for behavior.
- Architecture details remain for next phase (where to place command/state plumbing, and how to structure the non-empty-draft prompt UX in current client patterns).
