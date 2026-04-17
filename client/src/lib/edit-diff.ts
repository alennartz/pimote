import { JSONParser } from '@streamparser/json';

/**
 * Edit tool diff rendering helpers.
 *
 * The display of edit tool calls bypasses the streaming-markdown pipeline
 * entirely — it renders directly from structured entries via
 * `EditDiffBlock.svelte`. This avoids the append-only contract imposed by
 * smd and lets us color each `-`/`+` line the moment it arrives, rather
 * than waiting for a closing fence.
 *
 * Two producers of entries:
 *
 *   - Finalized path: `content.args.edits` is already an array of
 *     `{ oldText, newText }`. Pass it straight to the component.
 *   - Streaming path: `createEditDiffStreamer()` consumes raw JSON deltas
 *     from `content.text` and exposes a live `entries` array that grows
 *     character-by-character as values come in.
 *
 * `buildEditLines()` turns one entry into the per-line rendering shape
 * used by the component; it's also the natural unit test surface.
 */

export interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export interface EditEntry {
  oldText: string;
  newText: string;
}

/** Kind of diff line, maps 1:1 to highlight.js diff-language span classes. */
export type EditLineKind = 'deletion' | 'addition';

export interface EditLine {
  kind: EditLineKind;
  /** Full line text including the `- ` or `+ ` prefix. */
  text: string;
}

/**
 * Turn one edit entry into an ordered list of diff lines.
 *
 * - Every line of `oldText` becomes a `deletion` line with a `- ` prefix.
 * - Every line of `newText` becomes an `addition` line with a `+ ` prefix.
 * - Empty `oldText`/`newText` contributes no lines on that side.
 * - An entry with both sides empty produces an empty array.
 *
 * Splitting on `\n` means a trailing newline produces a trailing empty
 * line (prefix only). This matches how the previous markdown renderer
 * behaved and is what users see when they stream an oldText value like
 * `"a\n"` mid-edit.
 */
export function buildEditLines(entry: EditEntry): EditLine[] {
  const lines: EditLine[] = [];
  if (entry.oldText !== '') {
    for (const line of entry.oldText.split('\n')) lines.push({ kind: 'deletion', text: `- ${line}` });
  }
  if (entry.newText !== '') {
    for (const line of entry.newText.split('\n')) lines.push({ kind: 'addition', text: `+ ${line}` });
  }
  return lines;
}

export interface EditDiffStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /**
   * Live view of parsed entries. The returned array is the same reference
   * each time; callers that need reactivity should copy it or snapshot
   * individual fields when updating Svelte state.
   */
  readonly entries: ReadonlyArray<EditEntry>;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Create a stateful builder that consumes raw JSON deltas (as they arrive
 * in `content.text`) and exposes a growing `entries` array reflecting the
 * latest partial and final `oldText` / `newText` values for each edit.
 *
 * Behavior:
 * - Internally constructs a `JSONParser` configured with
 *   `emitPartialValues: true` and
 *   `paths: ['$.edits.*.oldText', '$.edits.*.newText']`.
 * - Each `onValue` callback overwrites the matching field on the entry
 *   at the given index. New indexes extend the array in-place.
 * - Parser errors are swallowed silently; `entries` simply stops
 *   advancing past the failure point.
 * - `dispose()` is idempotent and does not mutate `entries`.
 */
export function createEditDiffStreamer(): EditDiffStreamer {
  const entries: EditEntry[] = [];
  let errored = false;
  let disposed = false;

  const ensureEntry = (index: number): EditEntry => {
    while (entries.length <= index) entries.push({ oldText: '', newText: '' });
    return entries[index];
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
        // Find the edit index: the numeric key in the stack (element
        // index in the outer `edits` array).
        let index: number | undefined;
        for (const frame of info.stack) {
          if (typeof frame.key === 'number') {
            index = frame.key;
            break;
          }
        }
        if (index === undefined) return;
        const text = typeof info.value === 'string' ? info.value : '';
        ensureEntry(index)[key] = text;
      } catch {
        errored = true;
      }
    };
    parser.onError = () => {
      errored = true;
    };
  }

  return {
    get entries() {
      return entries;
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
