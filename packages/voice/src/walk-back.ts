// Walk-back surgery — pure function that rewrites the tail of the LLM context
// to match what the user actually heard before a speechmux rollback/abort.
//
// Context and contract are defined in docs/plans/voice-mode.md — section
// "Walk-back surgery contract". This file mirrors that contract exactly.

import type { AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Minimal shape of a `speak(...)` tool_use content block. We only access
 * `type`, `name`, `input.text` — other fields are passed through unchanged.
 */
export interface SpeakToolUseBlock {
  type: 'tool_use';
  name: 'speak';
  id?: string;
  input: { text: string };
  [key: string]: unknown;
}

/** Any non-speak block — free text, other tool_use, thinking, etc. */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock = SpeakToolUseBlock | OtherBlock;

/** Input to `walkBack`. */
export interface WalkBackInput {
  /** Watermark from the last `rollback`/`abort` speechmux frame. Null if no rollback pending. */
  heardText: string | null;
  /** Snapshot of the streaming assistant message captured at abort time. Null if none. */
  captured: {
    role: 'assistant';
    content: ContentBlock[];
    stopReason?: string;
    [key: string]: unknown;
  } | null;
  /** Messages pi is about to feed to the LLM — ends with pi's synthetic empty-text aborted assistant. */
  messages: AgentMessage[];
}

/** A `speak` block has an empty-content-blocks tool_result somewhere in the
 *  downstream messages (role === 'toolResult' with matching tool_use_id). We
 *  drop those paired results when their tool_use is dropped or truncated. */
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
    const t = (b as unknown as { text?: unknown }).text;
    return typeof t === 'string' && t.trim() === '';
  });
}

/** True for the synthetic assistant pi appends to state on abort. */
export function isAbortedEmptyAssistant(msg: AgentMessage): boolean {
  return isAssistantMessage(msg) && stopReason(msg) === 'aborted' && isEmptyText(contentOf(msg));
}

function isSpeakToolUse(block: ContentBlock): block is SpeakToolUseBlock {
  if (block.type !== 'tool_use') return false;
  const name = (block as { name?: unknown }).name;
  return name === 'speak';
}

function toolUseId(block: ContentBlock): string | undefined {
  const id = (block as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function toolUseIdOfResult(block: ContentBlock): string | undefined {
  const id = (block as { tool_use_id?: unknown }).tool_use_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Apply the walk-back surgery contract.
 *
 * Returns a new `messages` array suitable for assigning to ContextEventResult.messages.
 *
 * See docs/plans/voice-mode.md → "Walk-back surgery contract" for the
 * authoritative behavioural spec.
 */
export function walkBack(input: WalkBackInput): AgentMessage[] {
  const { heardText, captured, messages } = input;

  // --- Step 1: strip trailing empty-text aborted assistants (always). ---
  let out = messages.slice();
  while (out.length > 0 && isAbortedEmptyAssistant(out[out.length - 1]!)) {
    out.pop();
  }

  // Idempotency: without a new rollback, steps 2–4 are skipped.
  if (heardText === null || captured === null) {
    return out;
  }

  // --- Step 2: turn produced no audible output AND user heard nothing. ---
  const capturedHadSpeak = captured.content.some((b) => isSpeakToolUse(b) && b.input.text.length > 0);
  if (heardText === '' && !capturedHadSpeak) {
    return out;
  }

  // --- Step 3: walk blocks, accumulating spoken characters. ---
  const kept: ContentBlock[] = [];
  const droppedToolUseIds = new Set<string>();
  let spoken = '';
  let truncated = false;

  for (const block of captured.content) {
    if (truncated) {
      // After truncation we drop everything.
      const id = toolUseId(block);
      if (id) droppedToolUseIds.add(id);
      continue;
    }

    if (isSpeakToolUse(block)) {
      const arg = block.input.text;
      const combined = spoken + arg;
      if (heardText.startsWith(combined)) {
        // Entire speak chunk was heard — keep whole.
        kept.push(block);
        spoken = combined;
      } else if (spoken.length < heardText.length) {
        // Partial — truncate the text to exactly what remains of heardText.
        // Per contract: a truncated speak also drops its paired tool_result.
        const remaining = heardText.slice(spoken.length);
        const truncatedBlock: SpeakToolUseBlock = {
          ...block,
          input: { ...block.input, text: remaining },
        };
        kept.push(truncatedBlock);
        spoken = heardText;
        truncated = true;
        const id = toolUseId(block);
        if (id) droppedToolUseIds.add(id);
      } else {
        // spoken already >= heardText — drop block.
        const id = toolUseId(block);
        if (id) droppedToolUseIds.add(id);
      }
    } else {
      // Non-speak block.
      if (spoken.length < heardText.length) {
        kept.push(block);
      } else {
        const id = toolUseId(block);
        if (id) droppedToolUseIds.add(id);
      }
    }
  }

  // --- Step 4: append reconstructed assistant message (retain stopReason). ---
  const reconstructed = {
    ...captured,
    role: 'assistant' as const,
    content: kept,
    stopReason: captured.stopReason ?? 'aborted',
  } as unknown as AgentMessage;
  out.push(reconstructed);

  // Drop paired tool_result blocks in any subsequent toolResult messages.
  // Speak results normally don't follow an aborted turn, but we handle it
  // defensively per the contract ("the paired tool_result block (if present)
  // is also dropped").
  if (droppedToolUseIds.size > 0) {
    out = out.map((msg) => {
      if ((msg as { role?: string }).role !== 'toolResult') return msg;
      const filtered = contentOf(msg).filter((b) => {
        if (b.type !== 'tool_result') return true;
        const id = toolUseIdOfResult(b);
        return !id || !droppedToolUseIds.has(id);
      });
      return { ...(msg as object), content: filtered } as unknown as AgentMessage;
    });
  }

  return out;
}
