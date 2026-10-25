import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { getGitBranch } from './git-branch.js';
import { RepoIndex } from './repo-index.js';

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type ExecCall = {
  file: string;
  args: string[];
  options: ExecOptions;
};

const calls: ExecCall[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
  calls.length = 0;
  execFileMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function installGitMock(outputFor: (args: readonly string[]) => string): void {
  execFileMock.mockImplementation((...params: unknown[]) => {
    const file = params[0] as string;
    const args = [...(params[1] as string[])];
    const options = params[2] as ExecOptions;
    const callback = params[params.length - 1] as (error: null, result: { stdout: string; stderr: string }) => void;
    calls.push({ file, args, options });
    callback(null, { stdout: outputFor(args), stderr: '' });
  });
}

function expectLockedEnvironment(): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.options.env?.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(call.options.env).not.toBe(process.env);
  }
  expect(process.env.GIT_OPTIONAL_LOCKS).toBe('1');
}

describe('background git readers', () => {
  it('overrides inherited lock settings for branch and fallback readers', async () => {
    installGitMock((args) => {
      if (args.join(' ') === 'branch --show-current') return '';
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      return '';
    });

    await expect(getGitBranch('/repo')).resolves.toBe('main');

    expect(calls.map((call) => call.args)).toEqual([
      ['branch', '--show-current'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
    ]);
    expectLockedEnvironment();
  });

  it('overrides inherited lock settings for status, upstream, and ahead-behind readers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-readers-test-'));
    tempDirs.push(root);
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });

    const outputs = new Map([
      ['branch --show-current', 'main\n'],
      ['status --porcelain', ''],
      ['rev-parse --abbrev-ref @{upstream}', 'origin/main\n'],
      ['rev-list --count origin/main..HEAD', '2\n'],
      ['rev-list --count HEAD..origin/main', '3\n'],
    ]);
    installGitMock((args) => outputs.get(args.join(' ')) ?? '');

    const index = new RepoIndex([root], { now: () => 0, ttlMs: 1_000, statusTtlMs: 1_000 });
    const row = (await index.list()).find((entry) => entry.path === repo);

    expect(row).toMatchObject({ branch: 'main', dirty: false, ahead: 2, behind: 3 });
    expect(calls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ['branch', '--show-current'],
        ['status', '--porcelain'],
        ['rev-parse', '--abbrev-ref', '@{upstream}'],
        ['rev-list', '--count', 'origin/main..HEAD'],
        ['rev-list', '--count', 'HEAD..origin/main'],
      ]),
    );
    expect(calls).toHaveLength(5);
    expectLockedEnvironment();
  });
});
