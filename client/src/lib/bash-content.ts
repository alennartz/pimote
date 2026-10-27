/**
 * Bash tool command extraction helpers.
 *
 * Tool-call arguments arrive as raw JSON while a call streams. Keep the
 * command source separate from that JSON so the tool view can render it as
 * highlighted bash, just like codemode renders its script source.
 */
import { JSONParser } from '@streamparser/json';

export interface BashArgs {
  command: string;
}

/**
 * Extract the command source from finalized `bash` tool arguments.
 *
 * Returns `args.command` when it is a string, or `''` for any other shape.
 */
export function extractBashCommand(args: unknown): string {
  if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string') {
    return (args as Record<string, unknown>).command as string;
  }
  return '';
}

export interface BashCommandStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /** Live, growing view of the extracted command source. */
  readonly command: string;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Create a stateful builder that consumes raw JSON deltas and exposes the
 * growing `command` field from a bash tool call.
 */
export function createBashCommandStreamer(): BashCommandStreamer {
  let command = '';
  let errored = false;
  let disposed = false;

  let parser: JSONParser | null = null;
  try {
    parser = new JSONParser({
      emitPartialTokens: true,
      emitPartialValues: true,
      paths: ['$.command'],
      keepStack: false,
    });
  } catch {
    errored = true;
  }

  if (parser) {
    parser.onValue = (info) => {
      try {
        if (typeof info.value === 'string') command = info.value;
      } catch {
        errored = true;
      }
    };
    parser.onError = () => {
      errored = true;
    };
  }

  return {
    get command() {
      return command;
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
