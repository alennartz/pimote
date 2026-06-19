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

import type { AgentMessage } from '@earendil-works/pi-agent-core';

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

  // Walkback is about what the user *heard* (speech), not about undoing the
  // agent's real work. So we surgically prune only speak() calls from the
  // target onward — truncate/drop the target, drop later speaks — and keep
  // every other tool call (and its result) and other content intact. Results
  // of pruned speaks are dropped too (a tool_result with no tool_use is the
  // riskier dangling direction). `stopReason` is preserved, not synthesised:
  // the target is no longer necessarily the last message.
  const droppedSpeakIds = new Set<string>();

  const targetMsg = messages[targetMsgIdx]!;
  const targetContent = contentOf(targetMsg);
  const targetBlock = targetContent[targetBlockIdx]!;
  const originalText = getSpeakText(targetBlock);

  // Blocks before the target were spoken/heard earlier in the turn — keep.
  const newBlocks: ContentBlock[] = targetContent.slice(0, targetBlockIdx);

  if (heardText.length === 0) {
    droppedSpeakIds.add(targetId); // nothing heard — drop the speak + its result
  } else if (heardText.length >= originalText.length) {
    newBlocks.push(targetBlock); // whole utterance heard — keep intact (+ its result)
  } else {
    newBlocks.push(replaceSpeakText(targetBlock, heardText)); // partial — truncate
    droppedSpeakIds.add(targetId); // a truncated speak's result is no longer grounded
  }

  // Blocks after the target in the same message: drop later speaks, keep the rest.
  for (let j = targetBlockIdx + 1; j < targetContent.length; j++) {
    const block = targetContent[j]!;
    if (isSpeakToolCall(block)) {
      const id = getToolCallId(block);
      if (id) droppedSpeakIds.add(id);
    } else {
      newBlocks.push(block);
    }
  }

  const out: AgentMessage[] = messages.slice(0, targetMsgIdx);
  if (newBlocks.length > 0) {
    out.push({ ...(targetMsg as object), content: newBlocks } as unknown as AgentMessage);
  }

  // Subsequent messages: keep them, but drop speak tool calls (and the
  // tool_results of any dropped speak). Forward iteration guarantees a speak's
  // id is recorded before its (later) result message is examined.
  for (let i = targetMsgIdx + 1; i < messages.length; i++) {
    const kept = filterPrunedSpeaks(messages[i]!, droppedSpeakIds);
    if (kept) out.push(kept);
  }
  return out;
}

/**
 * Drop pruned-speak content from a trailing message: removes speak tool calls
 * (recording their ids) and the tool_results of any dropped speak, keeping all
 * other content. Returns the (possibly rewritten) message, or null if it ends
 * up empty.
 */
function filterPrunedSpeaks(msg: AgentMessage, droppedSpeakIds: Set<string>): AgentMessage | null {
  // pi's runtime shape: a tool result is its own message (role 'toolResult')
  // referencing one toolCallId at the message level.
  if (isToolResultMessage(msg)) {
    const ref = toolResultMessageRefId(msg);
    return ref && droppedSpeakIds.has(ref) ? null : msg;
  }

  const content = contentOf(msg);
  if (content.length === 0) return msg;

  let changed = false;
  const kept: ContentBlock[] = [];
  for (const block of content) {
    if (isSpeakToolCall(block)) {
      const id = getToolCallId(block);
      if (id) droppedSpeakIds.add(id);
      changed = true;
      continue;
    }
    // Block-level tool_result (Anthropic shape) for a dropped speak.
    if (isToolResultBlock(block)) {
      const ref = toolResultBlockRefId(block);
      if (ref && droppedSpeakIds.has(ref)) {
        changed = true;
        continue;
      }
    }
    kept.push(block);
  }

  if (!changed) return msg;
  if (kept.length === 0) return null;
  return { ...(msg as object), content: kept } as unknown as AgentMessage;
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

/** pi runtime tool-result message (role 'toolResult', message-level toolCallId). */
function isToolResultMessage(msg: AgentMessage): boolean {
  return (msg as { role?: string }).role === 'toolResult';
}

function toolResultMessageRefId(msg: AgentMessage): string | undefined {
  const id = (msg as { toolCallId?: unknown }).toolCallId;
  return typeof id === 'string' ? id : undefined;
}

/** Block-level tool result (Anthropic `tool_result` / pi `toolResult`). */
function isToolResultBlock(block: ContentBlock): boolean {
  return block.type === 'tool_result' || block.type === 'toolResult';
}

function toolResultBlockRefId(block: ContentBlock): string | undefined {
  const ref = (block as { tool_use_id?: unknown }).tool_use_id ?? (block as { toolCallId?: unknown }).toolCallId;
  return typeof ref === 'string' ? ref : undefined;
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
