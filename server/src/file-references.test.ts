import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { completeFileRefs, type FdInvocation, type FdRunResult, type FdRunner } from './file-references.js';

const CWD = '/home/user/project';

/**
 * Build a capturing fd runner. Records every invocation and returns canned
 * stdout `lines` (directory entries must carry a trailing `/`, mirroring `fd`).
 */
function fakeFd(lines: string[], available = true): { runFd: FdRunner; calls: FdInvocation[] } {
  const calls: FdInvocation[] = [];
  const runFd: FdRunner = async (invocation: FdInvocation): Promise<FdRunResult> => {
    calls.push(invocation);
    return { available, lines };
  };
  return { runFd, calls };
}

describe('completeFileRefs — fd invocation construction', () => {
  it('always asks fd for both files and directories, hidden, following symlinks', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@foo', cwd: CWD, runFd });

    expect(calls).toHaveLength(1);
    const { args } = calls[0]!;
    // --type f --type d  (files and directories)
    expect(args).toContain('--type');
    expect(args).toContain('f');
    expect(args).toContain('d');
    expect(args).toContain('--hidden');
    expect(args).toContain('--follow');
  });

  it('excludes the .git directory and caps the result count', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@foo', cwd: CWD, runFd });

    const { args } = calls[0]!;
    expect(args).toContain('--exclude');
    expect(args).toContain('.git');
    expect(args).toContain('--max-results');
  });

  it('passes a bare single-segment prefix as the fd query pattern', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@comp', cwd: CWD, runFd });

    expect(calls[0]!.query).toBe('comp');
  });

  it('does not pass --full-path for a bare single-segment prefix', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@foo', cwd: CWD, runFd });
    expect(calls[0]!.args).not.toContain('--full-path');
  });

  it('scopes a multi-segment prefix at the last slash: queries the trailing segment, no --full-path', async () => {
    // pimote scopes by splitting at the last '/': the directory portion becomes
    // the fd base directory and the trailing segment becomes the fd query, so
    // the query never contains a separator and --full-path is never used. This
    // guards against a naive impl that derives --full-path from the raw prefix
    // while scoping the query.
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@src/comp', cwd: CWD, runFd });
    const inv = calls[0]!;
    expect(inv.query).toBe('comp');
    expect(inv.baseDir).toBe(join(CWD, 'src'));
    expect(inv.args).not.toContain('--full-path');
  });

  it('scopes a deeply nested prefix at the last slash', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@a/b/c', cwd: CWD, runFd });
    const inv = calls[0]!;
    expect(inv.query).toBe('c');
    expect(inv.baseDir).toBe(join(CWD, 'a', 'b'));
    expect(inv.args).not.toContain('--full-path');
  });
});

describe('completeFileRefs — base directory resolution', () => {
  it('resolves a bare relative prefix against the session cwd', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@foo', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe(CWD);
  });

  it('lists the named subdirectory when the prefix ends with a slash', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@sub/', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe(join(CWD, 'sub'));
    expect(calls[0]!.query).toBe('');
  });

  it('lists the cwd itself for the ./ prefix', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@./', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe(CWD);
  });

  it('lists the parent directory for the ../ prefix', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@../', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe(dirname(CWD));
  });

  it('uses an absolute base directory for an absolute prefix', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@/tmp/', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe('/tmp');
  });

  it('expands ~/ to the home directory for the search root', async () => {
    const { runFd, calls } = fakeFd([]);
    await completeFileRefs({ prefix: '@~/', cwd: CWD, runFd });
    expect(calls[0]!.baseDir).toBe(homedir());
  });
});

describe('completeFileRefs — item mapping', () => {
  it('maps a file entry to an @-prefixed terminal token', async () => {
    const { runFd } = fakeFd(['index.ts']);
    const { items } = await completeFileRefs({ prefix: '@', cwd: CWD, runFd });

    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe('@index.ts');
    expect(items[0]!.value.endsWith('/')).toBe(false);
    expect(items[0]!.label).toBe('index.ts');
  });

  it('gives directory entries a trailing slash in the inserted token', async () => {
    const { runFd } = fakeFd(['components/']);
    const { items } = await completeFileRefs({ prefix: '@', cwd: CWD, runFd });

    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe('@components/');
  });

  it('reconstructs the full token by prepending the typed directory scope', async () => {
    const { runFd } = fakeFd(['index.ts', 'nested/']);
    const { items } = await completeFileRefs({ prefix: '@src/', cwd: CWD, runFd });

    const values = items.map((i) => i.value);
    expect(values).toContain('@src/index.ts');
    expect(values).toContain('@src/nested/');
  });

  it('preserves the typed ~/ scope in the inserted token rather than the expanded home path', async () => {
    const { runFd } = fakeFd(['notes.txt']);
    const { items } = await completeFileRefs({ prefix: '@~/', cwd: CWD, runFd });

    expect(items[0]!.value).toBe('@~/notes.txt');
  });
});

describe('completeFileRefs — quoting', () => {
  it('quotes the inserted token when the path contains a space', async () => {
    const { runFd } = fakeFd(['my file.ts']);
    const { items } = await completeFileRefs({ prefix: '@', cwd: CWD, runFd });

    expect(items[0]!.value).toBe('@"my file.ts"');
  });

  it('quotes the inserted token when the prefix was already a quoted @"…" token', async () => {
    const { runFd } = fakeFd(['index.ts']);
    const { items } = await completeFileRefs({ prefix: '@"src/', cwd: CWD, runFd });

    expect(items[0]!.value).toBe('@"src/index.ts"');
  });
});

describe('completeFileRefs — fd availability', () => {
  it('reports fd as available and returns mapped items when fd runs', async () => {
    const { runFd } = fakeFd(['a.ts']);
    const result = await completeFileRefs({ prefix: '@', cwd: CWD, runFd });

    expect(result.fdAvailable).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('returns no items but stays available when fd runs and matches nothing', async () => {
    const { runFd } = fakeFd([]);
    const result = await completeFileRefs({ prefix: '@nope', cwd: CWD, runFd });

    expect(result.fdAvailable).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('degrades to empty items and signals unavailability when fd is missing', async () => {
    const { runFd } = fakeFd([], false);
    const result = await completeFileRefs({ prefix: '@foo', cwd: CWD, runFd });

    expect(result.fdAvailable).toBe(false);
    expect(result.items).toEqual([]);
  });
});
