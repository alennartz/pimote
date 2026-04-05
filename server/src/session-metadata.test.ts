import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
