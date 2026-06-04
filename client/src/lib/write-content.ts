/**
 * Write tool content extraction helpers.
 *
 * Mirrors `edit-diff.ts`: the `write` tool view needs the file body rendered
 * from the first delta, not escaped JSON. Two producers:
 *
 *   - Finalized path: `extractWriteContent(content.args)` pulls `args.content`
 *     out of the settled arguments object.
 *   - Streaming path: `createWriteContentStreamer()` consumes raw JSON deltas
 *     from `content.text` via `@streamparser/json` reading `$.content`, and
 *     exposes a live, growing `content` string.
 *
 * Byte-identity contract: after a full args JSON is fed in chunks, the
 * streamer's `content` equals `extractWriteContent(finalArgs)` exactly — the
 * streaming→finalized handoff is invisible. This is the same contract
 * `edit-diff.ts` established for the edit tool. The streaming implementation is
 * backed by `@streamparser/json`.
 */
import { JSONParser } from '@streamparser/json';

export interface WriteArgs {
  path: string;
  content: string;
}

/**
 * Extract the file body from finalized `write` tool arguments.
 *
 * Returns `args.content` when it is a string; returns `''` when `args` is
 * absent, not an object, or has no string `content` field.
 */
export function extractWriteContent(args: unknown): string {
  if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).content === 'string') {
    return (args as Record<string, unknown>).content as string;
  }
  return '';
}

export interface WriteContentStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /**
   * Live, growing view of the extracted file body. Grows monotonically as
   * partial values arrive.
   */
  readonly content: string;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Create a stateful builder that consumes raw JSON deltas (as they arrive in
 * `content.text`) and exposes a growing `content` string reflecting the latest
 * partial and final value of the `write` tool's `content` field.
 *
 * Behavior:
 * - Internally constructs a `JSONParser` configured with `emitPartialTokens:
 *   true`, `emitPartialValues: true`, `paths: ['$.content']`, `keepStack:
 *   false`.
 * - Each emitted value overwrites the exposed `content`.
 * - Parser errors are swallowed silently; `content` simply stops advancing
 *   past the failure point.
 * - `dispose()` is idempotent and does not mutate `content`.
 */
export function createWriteContentStreamer(): WriteContentStreamer {
  let content = '';
  let errored = false;
  let disposed = false;

  let parser: JSONParser | null = null;
  try {
    parser = new JSONParser({
      emitPartialTokens: true,
      emitPartialValues: true,
      paths: ['$.content'],
      keepStack: false,
    });
  } catch {
    errored = true;
  }

  if (parser) {
    parser.onValue = (info) => {
      try {
        if (typeof info.value === 'string') content = info.value;
      } catch {
        errored = true;
      }
    };
    parser.onError = () => {
      errored = true;
    };
  }

  return {
    get content() {
      return content;
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
