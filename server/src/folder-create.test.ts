import { describe, expect, it } from 'vitest';
import { mkdir, readFile, realpath, rm, symlink, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderListing } from './folder-listing.js';
import { createCodeFolder } from './folder-create.js';
import { SessionRecords } from './session-records.js';
import { SessionSummaryIndex, sessionDirFor } from './session-summaries.js';

function row(path: string): FolderInfo {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
  };
}

describe('createCodeFolder()', () => {
  it('canonicalizes the built-in folder path reached through a root alias', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'folder-create-test-'));
    try {
      const actualRoot = join(tempDir, 'root');
      const aliasRoot = join(tempDir, 'root-alias');
      await mkdir(actualRoot);
      await symlink(actualRoot, aliasRoot);

      const created = await createCodeFolder(aliasRoot, 'custom', 'Created by the test.');
      const canonical = await realpath(join(aliasRoot, 'custom'));

      expect(created.folderPath).toBe(canonical);
      expect(created.folderPath).toBe(join(actualRoot, 'custom'));
      await expect(readFile(join(canonical, 'AGENTS.md'), 'utf8')).resolves.toContain('Created by the test.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('hands the canonical core-created path to the delta boundary', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'folder-delta-test-'));
    try {
      const actualRoot = join(tempDir, 'root');
      const aliasRoot = join(tempDir, 'root-alias');
      await mkdir(actualRoot);
      await symlink(actualRoot, aliasRoot);

      const created = await createCodeFolder(aliasRoot, 'custom');
      const canonical = await realpath(join(aliasRoot, 'custom'));
      const listing = new FolderListing({
        listRows: async () => [row(canonical)],
        enrichRows: async () => {},
        sessionSummaries: { listMany: async () => new Map() },
        archivedLookup: () => new Map(),
        listLiveSessions: () => [],
      });

      const delta = await listing.buildDelta([created.folderPath], []);

      expect(delta.changed.map((folder) => folder.path)).toEqual([canonical]);
      expect(delta.removedPaths).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('makes session records available through the canonical creation path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'folder-record-test-'));
    try {
      const actualRoot = join(tempDir, 'root');
      const aliasRoot = join(tempDir, 'root-alias');
      const agentDir = join(tempDir, 'agent');
      await mkdir(actualRoot);
      await symlink(actualRoot, aliasRoot);

      const created = await createCodeFolder(aliasRoot, 'custom');
      const aliasPath = join(aliasRoot, 'custom');
      const canonicalPath = await realpath(aliasPath);
      const sessionDir = sessionDirFor(canonicalPath, agentDir);
      const aliasSessionDir = sessionDirFor(aliasPath, agentDir);
      const sessionPath = join(sessionDir, 'session-1.jsonl');
      expect(aliasPath).not.toBe(canonicalPath);
      expect(aliasSessionDir).not.toBe(sessionDir);
      expect(created.folderPath).toBe(canonicalPath);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: canonicalPath }) + '\n', 'utf8');

      const records = new SessionRecords(new SessionSummaryIndex(agentDir));

      await expect(records.resolveSessionPath(canonicalPath, 'session-1')).resolves.toBe(sessionPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
