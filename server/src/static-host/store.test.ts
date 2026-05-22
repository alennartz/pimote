import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStaticHostStore, type StaticHostStoreFile } from './store.js';

describe('FileStaticHostStore', () => {
  let dir: string;
  let store: FileStaticHostStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'static-host-store-'));
    store = new FileStaticHostStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read returns undefined when no file exists for the session', async () => {
    expect(await store.read('absent')).toBeUndefined();
  });

  it('write then read round-trips the entries verbatim', async () => {
    const file: StaticHostStoreFile = {
      version: 1,
      entries: [
        { slug: 'a', folderPath: '/x/a', cardMetadata: { title: 'A' } },
        { slug: 'b', folderPath: '/x/b', cardMetadata: { title: 'B', tag: 'beta', color: 'accent' } },
      ],
    };
    await store.write('sess', file);
    const back = await store.read('sess');
    expect(back).toEqual(file);
  });

  it('write overwrites existing state for the same session', async () => {
    await store.write('sess', { version: 1, entries: [{ slug: 'old', folderPath: '/o', cardMetadata: { title: 'Old' } }] });
    await store.write('sess', { version: 1, entries: [{ slug: 'new', folderPath: '/n', cardMetadata: { title: 'New' } }] });
    const back = await store.read('sess');
    expect(back?.entries.map((e) => e.slug)).toEqual(['new']);
  });

  it('write creates the storage directory if missing', async () => {
    const nested = join(dir, 'nested', 'deep');
    const nestedStore = new FileStaticHostStore(nested);
    await nestedStore.write('s', { version: 1, entries: [] });
    expect(await nestedStore.read('s')).toEqual({ version: 1, entries: [] });
  });

  it('write is atomic (no half-written file visible on disk)', async () => {
    // Indirect check: after a successful write, only the final file is
    // present in the directory \u2014 no `.tmp` siblings remain.
    await store.write('sess', { version: 1, entries: [] });
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(dir);
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('remove deletes an existing file', async () => {
    await store.write('sess', { version: 1, entries: [] });
    await store.remove('sess');
    expect(await store.read('sess')).toBeUndefined();
  });

  it('remove is a no-op when the file does not exist', async () => {
    await expect(store.remove('ghost')).resolves.toBeUndefined();
  });

  it('read of a corrupt JSON file rejects (does not silently return)', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'corrupt.json'), '{ not json', 'utf-8');
    await expect(store.read('corrupt')).rejects.toBeDefined();
  });

  it('stores files under one-file-per-session naming', async () => {
    await store.write('alpha', { version: 1, entries: [] });
    await store.write('beta', { version: 1, entries: [] });
    const raw = await readFile(join(dir, 'alpha.json'), 'utf-8');
    expect(JSON.parse(raw).version).toBe(1);
    const raw2 = await readFile(join(dir, 'beta.json'), 'utf-8');
    expect(JSON.parse(raw2).version).toBe(1);
  });
});
