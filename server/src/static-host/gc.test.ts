import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gcStaticHostStore } from './gc.js';

describe('gcStaticHostStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'static-host-gc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function touch(name: string): Promise<void> {
    await writeFile(join(dir, name), '{"version":1,"entries":[]}', 'utf-8');
  }

  it('deletes files whose sessionId is not in validSessionIds', async () => {
    await touch('alive.json');
    await touch('dead.json');

    await gcStaticHostStore({ storeDir: dir, validSessionIds: new Set(['alive']) });

    const names = await readdir(dir);
    expect(names).toEqual(['alive.json']);
  });

  it('keeps files whose sessionId is in validSessionIds', async () => {
    await touch('a.json');
    await touch('b.json');

    await gcStaticHostStore({ storeDir: dir, validSessionIds: new Set(['a', 'b']) });

    const names = await readdir(dir);
    expect(names.sort()).toEqual(['a.json', 'b.json']);
  });

  it('does nothing (and does not throw) when the directory does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    await expect(gcStaticHostStore({ storeDir: missing, validSessionIds: new Set() })).resolves.toBeUndefined();
  });

  it('handles an empty validSessionIds set by deleting every json file', async () => {
    await touch('a.json');
    await touch('b.json');

    await gcStaticHostStore({ storeDir: dir, validSessionIds: new Set() });

    expect(await readdir(dir)).toEqual([]);
  });

  it('leaves unrelated non-json files alone', async () => {
    await touch('a.json');
    await mkdir(join(dir, 'subdir'), { recursive: true });
    await writeFile(join(dir, 'README'), 'hi', 'utf-8');

    await gcStaticHostStore({ storeDir: dir, validSessionIds: new Set() });

    const names = (await readdir(dir)).sort();
    expect(names).toContain('README');
    expect(names).toContain('subdir');
    expect(names).not.toContain('a.json');
  });
});
