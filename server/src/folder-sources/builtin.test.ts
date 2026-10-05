import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuiltinCreator } from './builtin.js';

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'builtin-creator-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('createBuiltinCreator()', () => {
  it('describes a form asking for root and name', () => {
    const { label, paramSchema } = createBuiltinCreator().describe();

    expect(label.length).toBeGreaterThan(0);
    expect(paramSchema).toMatchObject({ root: 'string', name: 'string' });
  });

  it('creates the code folder and git-inits it', async () => {
    const root = join(tempDir, 'root');
    await mkdir(root, { recursive: true });

    const { path } = await createBuiltinCreator().create({ root, name: 'new-project' });

    expect(path).toBe(join(root, 'new-project'));
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path });
    expect(stdout.trim()).toBe('true');
  });

  it('rejects when the target folder already exists and touches nothing', async () => {
    const root = join(tempDir, 'root');
    const taken = join(root, 'taken');
    await mkdir(taken, { recursive: true });

    await expect(createBuiltinCreator().create({ root, name: 'taken' })).rejects.toThrow();
    // The pre-existing folder must remain a plain directory, not become a repo.
    await expect(execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: taken })).rejects.toThrow();
  });
});
