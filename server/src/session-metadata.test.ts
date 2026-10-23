import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSessionMetadataStore } from './session-metadata.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-session-metadata-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FileSessionMetadataStore', () => {
  it('starts empty when the metadata file does not exist', async () => {
    const store = new FileSessionMetadataStore(join(tempDir, 'session-metadata.json'));
    await store.initialize();

    expect(store.isArchived('/tmp/missing.jsonl')).toBe(false);
  });

  it('persists and reloads archived state by session path', async () => {
    const filePath = join(tempDir, 'session-metadata.json');
    const sessionPath = '/tmp/session-1.jsonl';

    const store = new FileSessionMetadataStore(filePath);
    await store.initialize();
    await store.setArchived(sessionPath, true);

    const reloaded = new FileSessionMetadataStore(filePath);
    await reloaded.initialize();

    expect(reloaded.isArchived(sessionPath)).toBe(true);
    expect(reloaded.get(sessionPath)?.archivedAt).toMatch(/T/);
  });

  it('clears archived state when setArchived(..., false) is called', async () => {
    const filePath = join(tempDir, 'session-metadata.json');
    const sessionPath = '/tmp/session-2.jsonl';

    const store = new FileSessionMetadataStore(filePath);
    await store.initialize();
    await store.setArchived(sessionPath, true);
    await store.setArchived(sessionPath, false);

    expect(store.isArchived(sessionPath)).toBe(false);

    const raw = await readFile(filePath, 'utf-8');
    expect(raw).not.toContain(sessionPath);
  });

  it('keeps committed metadata and archivedAt when persistence fails', async () => {
    const filePath = join(tempDir, 'session-metadata.json');
    const store = new FileSessionMetadataStore(filePath);
    await store.initialize();
    await store.setArchived('/session', true);
    const original = store.get('/session');
    const disk = await readFile(filePath, 'utf-8');
    await mkdir(filePath + '.tmp');

    await expect(store.setArchived('/session', false)).rejects.toThrow('Failed to save session metadata');
    expect(store.get('/session')).toEqual(original);
    expect(await readFile(filePath, 'utf-8')).toBe(disk);
    await expect(store.delete('/session')).rejects.toThrow('Failed to save session metadata');
    expect(store.get('/session')).toEqual(original);

    await rm(filePath + '.tmp', { recursive: true });
    await store.setArchived('/another', true);
    expect(store.get('/session')).toEqual(original);
  });

  it('serializes concurrent mutations without losing entries', async () => {
    const filePath = join(tempDir, 'session-metadata.json');
    const store = new FileSessionMetadataStore(filePath);
    await store.initialize();
    await Promise.all([store.setArchived('/one', true), store.setArchived('/two', true)]);
    const reloaded = new FileSessionMetadataStore(filePath);
    await reloaded.initialize();
    expect(reloaded.isArchived('/one')).toBe(true);
    expect(reloaded.isArchived('/two')).toBe(true);
  });

  it('deletes entries explicitly', async () => {
    const filePath = join(tempDir, 'session-metadata.json');
    const sessionPath = '/tmp/session-3.jsonl';

    const store = new FileSessionMetadataStore(filePath);
    await store.initialize();
    await store.setArchived(sessionPath, true);
    await store.delete(sessionPath);

    expect(store.get(sessionPath)).toBeUndefined();
  });
});
