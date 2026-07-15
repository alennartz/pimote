import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSessionJsonStore, gcSessionJsonStore, type SessionJsonStore } from './session-json-store.js';

type Document = { version: 1; entries: Array<{ id: string; value: string }> };

describe('FileSessionJsonStore', () => {
  let dir: string;
  let store: SessionJsonStore<Document>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-json-store-'));
    store = new FileSessionJsonStore<Document>(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when a session has no persisted document', async () => {
    await expect(store.read('absent')).resolves.toBeUndefined();
  });

  it('round-trips a typed document without changing its shape', async () => {
    const document: Document = { version: 1, entries: [{ id: 'a', value: 'A' }] };
    await store.write('session-a', document);
    await expect(store.read('session-a')).resolves.toEqual(document);
  });

  it('replaces the complete document on a later write', async () => {
    await store.write('session-a', { version: 1, entries: [{ id: 'old', value: 'old' }] });
    await store.write('session-a', { version: 1, entries: [{ id: 'new', value: 'new' }] });
    await expect(store.read('session-a')).resolves.toEqual({ version: 1, entries: [{ id: 'new', value: 'new' }] });
  });

  it('creates missing parent directories when writing', async () => {
    const nested = join(dir, 'nested', 'state');
    const nestedStore = new FileSessionJsonStore<Document>(nested);
    await nestedStore.write('session-a', { version: 1, entries: [] });
    await expect(nestedStore.read('session-a')).resolves.toEqual({ version: 1, entries: [] });
  });

  it('leaves no temporary sibling after a successful atomic write', async () => {
    await store.write('session-a', { version: 1, entries: [] });
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['session-a.json']);
  });

  it('stores one JSON document per session id', async () => {
    await store.write('alpha', { version: 1, entries: [] });
    await store.write('beta', { version: 1, entries: [] });
    await expect(readFile(join(dir, 'alpha.json'), 'utf8').then(JSON.parse)).resolves.toEqual({ version: 1, entries: [] });
    await expect(readFile(join(dir, 'beta.json'), 'utf8').then(JSON.parse)).resolves.toEqual({ version: 1, entries: [] });
  });

  it('removes an existing document', async () => {
    await store.write('session-a', { version: 1, entries: [] });
    await store.remove('session-a');
    await expect(store.read('session-a')).resolves.toBeUndefined();
  });

  it('treats removing a missing document as a no-op', async () => {
    await expect(store.remove('absent')).resolves.toBeUndefined();
  });

  it('treats corrupt JSON as an absent document instead of rejecting', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'corrupt.json'), '{ not valid json', 'utf8');
    await expect(store.read('corrupt')).resolves.toBeUndefined();
  });
});

describe('gcSessionJsonStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-json-gc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes JSON documents whose session id is not in the boot allow-list', async () => {
    await writeFile(join(dir, 'alive.json'), '{}', 'utf8');
    await writeFile(join(dir, 'orphan.json'), '{}', 'utf8');
    await gcSessionJsonStore({ storeDir: dir, validSessionIds: new Set(['alive']) });
    await expect(readdir(dir).then((names) => names.sort())).resolves.toEqual(['alive.json']);
  });

  it('keeps every document whose session id is still valid', async () => {
    await writeFile(join(dir, 'a.json'), '{}', 'utf8');
    await writeFile(join(dir, 'b.json'), '{}', 'utf8');
    await gcSessionJsonStore({ storeDir: dir, validSessionIds: new Set(['a', 'b']) });
    await expect(readdir(dir).then((names) => names.sort())).resolves.toEqual(['a.json', 'b.json']);
  });

  it('removes abandoned temporary files even for valid sessions', async () => {
    await writeFile(join(dir, 'alive.json'), '{}', 'utf8');
    await writeFile(join(dir, 'alive.json.tmp'), '{ half', 'utf8');
    await gcSessionJsonStore({ storeDir: dir, validSessionIds: new Set(['alive']) });
    await expect(readdir(dir).then((names) => names.sort())).resolves.toEqual(['alive.json']);
  });

  it('does not fail when the storage directory does not exist', async () => {
    const missing = join(dir, 'missing');
    await expect(gcSessionJsonStore({ storeDir: missing, validSessionIds: new Set() })).resolves.toBeUndefined();
  });

  it('leaves unrelated files and directories untouched', async () => {
    await writeFile(join(dir, 'README'), 'keep', 'utf8');
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'orphan.json'), '{}', 'utf8');
    await gcSessionJsonStore({ storeDir: dir, validSessionIds: new Set() });
    await expect(readdir(dir).then((names) => names.sort())).resolves.toEqual(['README', 'nested']);
  });
});
