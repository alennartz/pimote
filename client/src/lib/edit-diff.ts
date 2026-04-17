import { JSONParser } from '@streamparser/json';

/**
 * Edit tool diff rendering — turn `edit` tool call args into markdown diff
 * blocks for display in the client.
 *
 * The finalized path (`buildEditDiffMarkdown`) runs once args are complete.
 * The streaming path (`createEditDiffStreamer`) consumes raw JSON deltas as
 * they arrive over the wire and grows the same markdown incrementally.
 *
 * Both paths must produce byte-identical output once all deltas have been
 * consumed, so the rendered DOM does not re-layout when the component
 * transitions from streaming mode to parsed-args mode.
 */

export interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

/**
 * Pure, synchronous. Used for finalized/restored edits.
 *
 * - Returns the empty string if `args.edits` is missing or empty.
 * - Emits one ` ```diff ` block per edit entry, in order.
 * - Each line of `oldText` becomes a `-` line; each line of `newText` becomes
 *   a `+` line. No line-level diff computation.
 * - Empty `oldText` or empty `newText` still produces at least one marker
 *   line for the non-empty side (append-only shows `+` lines with no `-`;
 *   pure deletion shows `-` lines with no `+`).
 * - Lines preserve their original text verbatim aside from the `- ` / `+ `
 *   prefix.
 * - The file path from `args.path` is NOT included in the markdown.
 */
export function buildEditDiffMarkdown(args: EditArgs): string {
  if (!args || !args.edits || args.edits.length === 0) return '';
  return renderEditBlocks(args.edits);
}

/**
 * Shared renderer used by both the finalized and streaming paths. Accepts
 * a sparse-ish array of `{ oldText, newText }` with string defaults of ''.
 */
function renderEditBlocks(entries: ReadonlyArray<{ oldText?: string; newText?: string }>): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    const oldText = entry?.oldText ?? '';
    const newText = entry?.newText ?? '';
    const lines: string[] = ['```diff'];
    if (oldText !== '') {
      for (const line of oldText.split('\n')) lines.push(`- ${line}`);
    }
    if (newText !== '') {
      for (const line of newText.split('\n')) lines.push(`+ ${line}`);
    }
    lines.push('```');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export interface EditDiffStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /**
   * The current diff markdown string, reflecting every partial + complete
   * oldText/newText seen so far.
   */
  readonly markdown: string;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Create a stateful builder that consumes raw JSON deltas (as they arrive in
 * `content.text`) and produces a growing diff markdown string.
 *
 * Behavior:
 * - Internally constructs a `JSONParser` configured with
 *   `emitPartialValues: true` and
 *   `paths: ['$.edits.*.oldText', '$.edits.*.newText']`.
 * - Each `onValue` callback updates `markdown` so it reflects the latest
 *   partial value for the relevant edit index and field.
 * - A new `oldText` value for edit index N opens a new ` ```diff ` block
 *   (closing the previous one first with a blank line separator).
 * - A new `newText` value for edit index N appends `+` lines below the `-`
 *   lines of that same block.
 * - As a partial string grows (character by character), the corresponding
 *   `-`/`+` lines update in place within `markdown`. Newlines inside the
 *   partial value split into additional `-`/`+` lines.
 * - Empty buffer before any `oldText`/`newText` has been seen → `markdown`
 *   is the empty string.
 * - `dispose()` is idempotent and does not mutate `markdown`.
 *
 * Parser errors are swallowed: `markdown` simply stops advancing.
 */
export function createEditDiffStreamer(): EditDiffStreamer {
  let markdown = '';
  const entries: Array<{ oldText: string; newText: string }> = [];
  let errored = false;
  let disposed = false;

  const ensureEntry = (index: number) => {
    while (entries.length <= index) entries.push({ oldText: '', newText: '' });
    return entries[index];
  };

  const rebuild = () => {
    markdown = entries.length === 0 ? '' : renderEditBlocks(entries);
  };

  let parser: JSONParser | null = null;
  try {
    parser = new JSONParser({
      emitPartialTokens: true,
      emitPartialValues: true,
      paths: ['$.edits.*.oldText', '$.edits.*.newText'],
      keepStack: false,
    });
  } catch {
    errored = true;
  }

  if (parser) {
    parser.onValue = (info) => {
      try {
        const key = info.key;
        if (key !== 'oldText' && key !== 'newText') return;
        // Find the edit index: the numeric key in the stack (element index in `edits` array).
        let index: number | undefined;
        for (const frame of info.stack) {
          if (typeof frame.key === 'number') {
            index = frame.key;
            break;
          }
        }
        if (index === undefined) return;
        const text = typeof info.value === 'string' ? info.value : '';
        const entry = ensureEntry(index);
        entry[key] = text;
        rebuild();
      } catch {
        errored = true;
      }
    };
    parser.onError = () => {
      errored = true;
    };
  }

  return {
    get markdown() {
      return markdown;
    },
    write(jsonDelta: string) {
      if (errored || disposed || !parser) return;
      try {
        parser.write(jsonDelta);
      } catch {
        errored = true;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        parser?.end();
      } catch {
        // ignore
      }
      parser = null;
    },
  };
}
