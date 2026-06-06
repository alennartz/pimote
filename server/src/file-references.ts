import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { AutocompleteResponseItem } from '../../shared/dist/index.js';

/** Cap on the number of fd results requested. */
const MAX_RESULTS = 50;

/**
 * `fd`-backed `@`-file-path autocomplete. Mirrors pi's interactive TUI `@`
 * behavior (`CombinedAutocompleteProvider` / `walkDirectoryWithFd`): parse the
 * incoming `@`-token, shell out to `fd` to walk the session's working tree, and
 * map the results into the generic `AutocompleteResponseItem` shape the client
 * already renders.
 *
 * This module is autocomplete-only. It does NOT expand `@` references into
 * `<file>` blocks, attach images, or otherwise materialize file contents — the
 * agent reads referenced files with its own `read` tool. The literal `@path`
 * text flows through the existing prompt/steer/follow_up commands unchanged.
 */

/**
 * A single `fd` invocation, surfaced as a seam so the actual subprocess can be
 * substituted in tests. `args` is the full argument vector passed to the `fd`
 * binary (flags + `--base-directory` + the positional query pattern). `baseDir`
 * and `query` are the resolved search root and positional pattern, exposed for
 * convenience so callers/tests don't have to re-derive them from `args`.
 */
export interface FdInvocation {
  /** The resolved `fd` executable path. */
  fdPath: string;
  /** The resolved search root passed via `--base-directory`. */
  baseDir: string;
  /** The positional fuzzy/path query pattern passed to `fd` (`''` when none). */
  query: string;
  /** The full argument vector handed to the `fd` process (excludes the executable itself). */
  args: string[];
}

/**
 * Result of running `fd`. `available` is `false` only when the `fd` binary is
 * missing (e.g. spawn `ENOENT`); any other failure degrades to `available:true`
 * with no `lines`. `lines` are `fd`'s stdout entries — paths relative to
 * `baseDir`, with directory entries carrying a trailing `/`.
 */
export interface FdRunResult {
  available: boolean;
  lines: string[];
}

/** Runs one `fd` invocation. The default runner spawns the real `fd` binary. */
export type FdRunner = (invocation: FdInvocation) => Promise<FdRunResult>;

export interface CompleteFileRefsInput {
  /** The `@`-token as typed, e.g. `@`, `@src/`, `@"my dir/`. */
  prefix: string;
  /** Session working directory; bare/relative/`./`/`../` prefixes resolve against this. */
  cwd: string;
  /** Optional `fd` executable path; defaults to looking up `fd` on PATH. */
  fdPath?: string;
  /** Optional `fd` runner seam; defaults to a real spawn-based runner. */
  runFd?: FdRunner;
}

export interface CompleteFileRefsResult {
  /**
   * Suggestions to render. `value` is the token to insert (leading `@`, quoting
   * when the path contains spaces or the prefix was quoted, trailing `/` for
   * directories); `label` is the display path. Empty when `fd` is unavailable.
   */
  items: AutocompleteResponseItem[];
  /**
   * `false` when `fd` is missing — the caller should surface a one-time warning.
   * `true` whenever `fd` ran (even if it produced no matches).
   */
  fdAvailable: boolean;
}

/**
 * Compute `@`-file-path autocomplete suggestions for the given prefix, resolved
 * against `cwd`. Returns `{ items: [], fdAvailable: false }` when `fd` is
 * missing so the caller can emit a one-time warning.
 */
export async function completeFileRefs(input: CompleteFileRefsInput): Promise<CompleteFileRefsResult> {
  const { cwd, prefix } = input;
  const fdPath = input.fdPath ?? 'fd';
  const runFd = input.runFd ?? defaultRunFd;

  const { quoted, scope, query } = parsePrefix(prefix);
  const baseDir = resolveBaseDir(scope, cwd);

  const args = ['--type', 'f', '--type', 'd', '--hidden', '--follow', '--exclude', '.git', '--max-results', String(MAX_RESULTS), '--base-directory', baseDir];
  if (query !== '') {
    args.push(query);
  }

  const invocation: FdInvocation = { fdPath, baseDir, query, args };
  const { available, lines } = await runFd(invocation);

  if (!available) {
    return { items: [], fdAvailable: false };
  }

  const items = lines.map((line) => mapLineToItem(line, scope, quoted));
  return { items, fdAvailable: true };
}

/**
 * Parse the raw `@`-token into the quoting flag, the typed directory scope (the
 * text up to and including the last `/`), and the fd query pattern (the trailing
 * segment after the last `/`).
 */
function parsePrefix(prefix: string): { quoted: boolean; scope: string; query: string } {
  let rest = prefix.startsWith('@') ? prefix.slice(1) : prefix;
  let quoted = false;
  if (rest.startsWith('"')) {
    quoted = true;
    rest = rest.slice(1);
  }
  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash === -1) {
    return { quoted, scope: '', query: rest };
  }
  return { quoted, scope: rest.slice(0, lastSlash + 1), query: rest.slice(lastSlash + 1) };
}

/** Resolve the typed scope string to an absolute search root against `cwd`. */
function resolveBaseDir(scope: string, cwd: string): string {
  if (scope === '') {
    return cwd;
  }
  if (scope === '~/' || scope.startsWith('~/')) {
    return resolve(homedir(), scope.slice(2));
  }
  if (isAbsolute(scope)) {
    return resolve(scope);
  }
  return resolve(cwd, scope);
}

/** Map one fd output line to an inserted-token autocomplete item. */
function mapLineToItem(line: string, scope: string, quoted: boolean): AutocompleteResponseItem {
  const path = scope + line;
  const needsQuote = quoted || path.includes(' ');
  const value = needsQuote ? `@"${path}"` : `@${path}`;
  return { value, label: line };
}

/**
 * Default fd runner: spawns the real `fd` binary. On spawn `ENOENT` reports
 * `available: false`; on any other failure degrades to `available: true` with no
 * lines; on success splits stdout into non-empty lines.
 */
const defaultRunFd: FdRunner = (invocation: FdInvocation): Promise<FdRunResult> =>
  new Promise((resolvePromise) => {
    execFile(invocation.fdPath, invocation.args, (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolvePromise({ available: false, lines: [] });
          return;
        }
        resolvePromise({ available: true, lines: [] });
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      resolvePromise({ available: true, lines });
    });
  });
