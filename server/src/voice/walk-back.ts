// Walkback rewrite: surgical truncation of conversation history when
// speechmux reports the user heard only a prefix of an assistant
// utterance.
//
// **Identity-based design.** Walkback targets a specific `speak()` tool
// call by its `toolCallId`. That id is round-tripped through speechmux
// (every outgoing `token`/`end` frame carries it; speechmux echoes it
// back on `rollback`/`abort`) so we know exactly which utterance the
// `heardText` belongs to. The previous design used a captured snapshot
// of the in-flight assistant message and a string-prefix-matching
// algorithm — both of which broke whenever a turn contained more than
// one speak() or whenever the snapshot drifted out of sync with the
// real conversation.
//
// **Contract:** see `docs/plans/voice-mode.md` for the high-level
// behavioural spec. Briefly:
//
//   1. The trailing pi-synthetic empty-text aborted assistant (if any)
//      is always stripped, even when no rollback is pending. This is
//      pi's marker for "agent run was aborted"; we don't want it in
//      the LLM context.
//
//   2. With a rollback pending, locate the speak block by
//      `targetSpeakToolCallId`. If found:
//        - If `heardText` is empty: drop the speak block entirely (and
//          its paired tool_result if present).
//        - If `heardText.length >= block.text.length`: keep block as-is
//          (whole utterance was heard).
//        - Otherwise: replace the block's text with `heardText` and
//          drop the paired tool_result.
//      Then drop blocks AFTER the target in the same message, and drop
//      any subsequent assistant/tool_result messages — none of those
//      could have been heard if the user interrupted at the target.
//
//   3. If the target is not found in messages (e.g. compacted away),
//      walkback is a no-op beyond step 1.
//
// **Content-block shape compatibility.** The function handles both
// pi-agent-core's internal AgentMessage shape (`type:'toolCall'` +
// `arguments`) and the Anthropic API shape (`type:'tool_use'` +
// `input`). Earlier versions only matched the latter, which silently
// failed on every real captured message.

import type { AgentMessage } from '@mariozechner/pi-agent-core';

/** Generic content block — we only inspect `type` + tool-call shape. */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** Helper output type kept for back-compat with downstream consumers. */
export interface SpeakToolUseBlock extends ContentBlock {
  type: 'tool_use' | 'toolCall';
  name: 'speak';
  id?: string;
  input?: { text: string };
  arguments?: { text: string };
}

/** Any non-speak block. */
export type OtherBlock = ContentBlock;

// ---------------------------------------------------------------------------

export interface WalkBackInput {
  /** The messages array pi is about to feed to the LLM. */
  messages: AgentMessage[];
  /**
   * If non-null, a rollback is pending: rewrite the targeted speak
   * block's text to `heardText` and drop everything after.
   */
  rollback: {
    heardText: string;
    targetSpeakToolCallId: string;
  } | null;
}

/**
 * Apply walkback against `messages`. Pure function.
 *
 * Returns a new array; never mutates the input.
 */
export function walkBack(input: WalkBackInput): AgentMessage[] {
  const stripped = stripTrailingAbortedEmpty(input.messages);
  if (input.rollback === null) return stripped;
  return rewriteByToolCallId(stripped, input.rollback.heardText, input.rollback.targetSpeakToolCallId);
}

// ---------------------------------------------------------------------------

/** True for the synthetic assistant pi appends to state on abort. */
export function isAbortedEmptyAssistant(msg: AgentMessage): boolean {
  if (!isAssistantMessage(msg)) return false;
  if (stopReason(msg) !== 'aborted') return false;
  return isEmptyText(contentOf(msg));
}

function stripTrailingAbortedEmpty(messages: AgentMessage[]): AgentMessage[] {
  let cut = messages.length;
  while (cut > 0 && isAbortedEmptyAssistant(messages[cut - 1]!)) cut -= 1;
  return cut === messages.length ? messages.slice() : messages.slice(0, cut);
}

function rewriteByToolCallId(messages: AgentMessage[], heardText: string, targetId: string): AgentMessage[] {
  // Search from the back — toolCallIds are unique per session, so the
  // first match is the right one, but searching backward minimises work
  // for the common case (target is in the recent tail).
  let targetMsgIdx = -1;
  let targetBlockIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (!isAssistantMessage(msg)) continue;
    const content = contentOf(msg);
    for (let j = 0; j < content.length; j++) {
      if (isSpeakToolCall(content[j]!) && getToolCallId(content[j]!) === targetId) {
        targetMsgIdx = i;
        targetBlockIdx = j;
        break;
      }
    }
    if (targetMsgIdx !== -1) break;
  }

  if (targetMsgIdx === -1) {
    // Target gone (compacted, or never landed in messages). Best we can
    // do is honour step 1 (already done).
    return messages;
  }

  const targetMsg = messages[targetMsgIdx]!;
  const targetContent = contentOf(targetMsg);
  const targetBlock = targetContent[targetBlockIdx]!;
  const originalText = getSpeakText(targetBlock);

  const newBlocks: ContentBlock[] = targetContent.slice(0, targetBlockIdx);
  const droppedToolUseIds = new Set<string>();

  if (heardText.length === 0) {
    // Nothing was heard of this speak. Drop the block and its paired
    // tool_result (if any).
    droppedToolUseIds.add(targetId);
  } else if (heardText.length >= originalText.length) {
    // Entire utterance was heard. Keep block intact.
    newBlocks.push(targetBlock);
  } else {
    // Partial. Truncate text in-place and drop the paired tool_result
    // (per the contract — a truncated speak's result is no longer
    // grounded in what the user heard).
    newBlocks.push(replaceSpeakText(targetBlock, heardText));
    droppedToolUseIds.add(targetId);
  }

  // Anything in this message AFTER the target block was emitted after
  // the heard prefix and so was not heard.
  for (let j = targetBlockIdx + 1; j < targetContent.length; j++) {
    const id = getToolCallId(targetContent[j]!);
    if (id) droppedToolUseIds.add(id);
  }

  const rewrittenTarget = {
    ...(targetMsg as object),
    content: newBlocks,
    stopReason: 'aborted',
  } as unknown as AgentMessage;

  // Anything AFTER the target message in the array was emitted by the
  // agent after the interrupted speak — drop it. This includes any
  // tool_result messages whose paired speak we just truncated, plus
  // any subsequent assistant messages.
  return [...messages.slice(0, targetMsgIdx), rewrittenTarget];
}

// ---------------------------------------------------------------------------
// Shape-tolerant accessors. pi-agent-core's runtime AgentMessage uses
// `toolCall`/`arguments`; the Anthropic API shape uses `tool_use`/`input`.
// Tests / tooling may pass either; we accept both.

function isAssistantMessage(msg: AgentMessage): boolean {
  return (msg as { role?: string }).role === 'assistant';
}

function stopReason(msg: AgentMessage): string | undefined {
  return (msg as { stopReason?: string }).stopReason;
}

function contentOf(msg: AgentMessage): ContentBlock[] {
  const c = (msg as { content?: unknown }).content;
  return Array.isArray(c) ? (c as ContentBlock[]) : [];
}

function isEmptyText(blocks: ContentBlock[]): boolean {
  if (blocks.length === 0) return true;
  return blocks.every((b) => {
    if (b.type !== 'text') return false;
    const t = (b as { text?: unknown }).text;
    return typeof t === 'string' && t.trim() === '';
  });
}

export function isSpeakToolCall(block: ContentBlock): boolean {
  if (block.type !== 'toolCall' && block.type !== 'tool_use') return false;
  return (block as { name?: unknown }).name === 'speak';
}

function getToolCallId(block: ContentBlock): string | undefined {
  const id = (block as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function getSpeakText(block: ContentBlock): string {
  // Try both shapes; whichever holds a string wins.
  const args = (block as { arguments?: unknown }).arguments;
  if (args && typeof args === 'object') {
    const t = (args as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  const input = (block as { input?: unknown }).input;
  if (input && typeof input === 'object') {
    const t = (input as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

function replaceSpeakText(block: ContentBlock, text: string): ContentBlock {
  // Preserve whichever args/input shape was present, replacing only the
  // `text` field. We don't normalise to a single shape — that would
  // diverge from whatever pi-agent-core/the provider expects.
  const args = (block as { arguments?: unknown }).arguments;
  const input = (block as { input?: unknown }).input;
  if (args && typeof args === 'object') {
    return { ...block, arguments: { ...(args as object), text } };
  }
  if (input && typeof input === 'object') {
    return { ...block, input: { ...(input as object), text } };
  }
  // Neither shape present — set both defensively.
  return { ...block, arguments: { text }, input: { text } };
}
