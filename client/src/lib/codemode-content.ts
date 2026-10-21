/**
 * Codemode tool code extraction helpers.
 *
 * Mirrors `write-content.ts`: the `codemode` tool view needs the script source
 * rendered from the first delta, not escaped JSON. Two producers:
 *
 *   - Finalized path: `extractCodemodeCode(content.args)` pulls `args.code`
 *     out of the settled arguments object.
 *   - Streaming path: `createCodemodeCodeStreamer()` consumes raw JSON deltas
 *     from `content.text` via `@streamparser/json` reading `$.code`, and
 *     exposes a live, growing `code` string.
 *
 * Byte-identity contract: after a full args JSON is fed in chunks, the
 * streamer's `code` equals `extractCodemodeCode(finalArgs)` exactly — the
 * streaming→finalized handoff is invisible. Same contract as `write-content.ts`
 * established for the write tool. The streaming implementation is backed by
 * `@streamparser/json`.
 */
import { JSONParser } from '@streamparser/json';

export interface CodemodeArgs {
  code: string;
}

/**
 * Extract the script source from finalized `codemode` tool arguments.
 *
 * Returns `args.code` when it is a string; returns `''` when `args` is
 * absent, not an object, or has no string `code` field.
 */
export function extractCodemodeCode(args: unknown): string {
  if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).code === 'string') {
    return (args as Record<string, unknown>).code as string;
  }
  return '';
}

export interface CodemodeCodeStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /**
   * Live, growing view of the extracted script source. Grows monotonically as
   * partial values arrive.
   */
  readonly code: string;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Create a stateful builder that consumes raw JSON deltas (as they arrive in
 * `content.text`) and exposes a growing `code` string reflecting the latest
 * partial and final value of the `codemode` tool's `code` field.
 *
 * Behavior:
 * - Internally constructs a `JSONParser` configured with `emitPartialTokens:
 *   true`, `emitPartialValues: true`, `paths: ['$.code']`, `keepStack: false`.
 * - Each emitted value overwrites the exposed `code`.
 * - Parser errors are swallowed silently; `code` simply stops advancing past
 *   the failure point.
 * - `dispose()` is idempotent and does not mutate `code`.
 */
export function createCodemodeCodeStreamer(): CodemodeCodeStreamer {
  let code = '';
  let errored = false;
  let disposed = false;

  let parser: JSONParser | null = null;
  try {
    parser = new JSONParser({
      emitPartialTokens: true,
      emitPartialValues: true,
      paths: ['$.code'],
      keepStack: false,
    });
  } catch {
    errored = true;
  }

  if (parser) {
    parser.onValue = (info) => {
      try {
        if (typeof info.value === 'string') code = info.value;
      } catch {
        errored = true;
      }
    };
    parser.onError = () => {
      errored = true;
    };
  }

  return {
    get code() {
      return code;
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
