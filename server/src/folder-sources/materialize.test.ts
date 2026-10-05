import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HubSourceEntry } from '@pimote/sdk/folders';
import { materializeHubFolder } from './materialize.js';
import { scanFolderModel } from '../folder-model/index.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let externalDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'materialize-test-'));
  externalDir = await mkdtemp(join(tmpdir(), 'materialize-external-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await rm(externalDir, { recursive: true, force: true });
});

function hubEntry(path: string, name: string, memberPaths: string[]): HubSourceEntry {
  return { kind: 'hub', path, name, memberPaths };
}

/** A folder the folder model classifies as code (a `.git` entry is enough for classification). */
async function codeFolder(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true });
}

describe('materializeHubFolder()', () => {
  it('materializes absolute member symlinks, the generated AGENTS.md, a git repo, and a member .gitignore', async () => {
    const memberA = join(externalDir, 'member-a');
    const memberB = join(externalDir, 'member-b');
    await codeFolder(memberA);
    await codeFolder(memberB);
    const hub = join(tempDir, 'group');

    await materializeHubFolder(hubEntry(hub, 'group', [memberA, memberB]));

    expect(await readlink(join(hub, 'member-a'))).toBe(memberA);
    expect(await readlink(join(hub, 'member-b'))).toBe(memberB);

    // The generated AGENTS.md contract, pinned verbatim (including the member
    // instructions precedence rule).
    await expect(readFile(join(hub, 'AGENTS.md'), 'utf8')).resolves.toBe(
      [
        '# group',
        '',
        'A multi-repo project. The member repositories below are symlinked into this directory:',
        '',
        `- member-a → ${memberA}`,
        `- member-b → ${memberB}`,
        '',
        '## Convention',
        '',
        'Each member directory is an independent git repository with its own AGENTS.md. When working',
        'inside a member directory, that repository is a sub-project: its AGENTS.md takes precedence',
        "over this file, and keep each repository's work inside its own directory.",
        '',
      ].join('\n'),
    );

    // The hub is self-describing: a git repo whose member links are ignored.
    expect((await stat(join(hub, '.git'))).isDirectory()).toBe(true);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: hub });
    expect(stdout.trim()).toBe('true');
    const ignore = await readFile(join(hub, '.gitignore'), 'utf8');
    expect(ignore.split('\n').filter(Boolean)).toEqual(['member-a', 'member-b']);
  });

  it('writes an empty .gitignore for a hub without members', async () => {
    const hub = join(tempDir, 'empty-group');
    await materializeHubFolder(hubEntry(hub, 'empty-group', []));

    expect((await readFile(join(hub, '.gitignore'), 'utf8')).trim()).toBe('');
  });

  it('runs git init in the hub folder even with inherited GIT_DIR/GIT_WORK_TREE', async () => {
    const bogusGitDir = join(tempDir, 'bogus-git-dir');
    const hub = join(tempDir, 'group');
    process.env.GIT_DIR = bogusGitDir;
    process.env.GIT_WORK_TREE = join(tempDir, 'bogus-work-tree');
    try {
      await materializeHubFolder(hubEntry(hub, 'group', []));
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }

    expect((await stat(join(hub, '.git'))).isDirectory()).toBe(true);
    await expect(stat(bogusGitDir)).rejects.toThrow();
  });

  it('scans as a code folder whose member shortcuts surface as shortcut occurrences', async () => {
    const memberA = join(externalDir, 'member-a');
    const memberB = join(externalDir, 'member-b');
    await codeFolder(memberA);
    await codeFolder(memberB);
    const hub = join(tempDir, 'group');
    await materializeHubFolder(hubEntry(hub, 'group', [memberA, memberB]));

    const tree = await scanFolderModel({ roots: [hub], onWarning: () => {} });
    expect(tree.occurrences).toHaveLength(1);
    const hubOccurrence = tree.occurrences[0];
    expect(hubOccurrence.entry.path).toBe(await realpath(hub));
    expect(hubOccurrence.entry.nature).toBe('code');

    const shortcuts = hubOccurrence.children;
    expect(shortcuts.map((o) => o.via)).toEqual(['shortcut', 'shortcut']);
    expect(new Set(shortcuts.map((o) => o.entry.path))).toEqual(new Set([await realpath(memberA), await realpath(memberB)]));
    expect(shortcuts.every((o) => o.entry.nature === 'code')).toBe(true);
  });
});
