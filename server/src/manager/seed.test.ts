import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedManagerRoot } from './seed.js';
import { classifyFolder, nodeFolderFs } from '../folder-model/index.js';

// Boot seeding of the manager root (plan: manager-lifecycle):
// AGENTS.md absent -> shipped vision/lookup map, present -> untouched (no
// merge, ever); memory.md absent -> stub, present -> untouched. The map points
// to the packaged README, the pimote-folders skill, and installation memory.

async function makeManagerRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'manager-seed-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('seedManagerRoot()', () => {
  it('writes the shipped AGENTS.md template and a memory.md stub when both are absent', async () => {
    const { root, cleanup } = await makeManagerRoot();
    try {
      await seedManagerRoot(root);

      const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
      expect(agents.trim().length).toBeGreaterThan(0);
      expect(agents).toContain('## Vision');
      expect(agents).toContain('## Lookup');
      expect(agents).toContain(fileURLToPath(new URL('../../../README.md', import.meta.url)));
      expect(agents).toContain('pimote-folders/SKILL.md');
      const classification = await classifyFolder(nodeFolderFs, root);
      expect(classification.nature).toBe('persona');
      expect(classification.persona?.name).toBe('manager');
      expect(classification.persona?.description?.trim().length).toBeGreaterThan(0);
      expect(classification.persona?.description).not.toContain('\n');
      expect(agents).toContain('## Vision');
      expect(agents).toContain('## Lookup');
      expect(agents).toContain(fileURLToPath(new URL('../../../README.md', import.meta.url)));
      expect(agents).toContain('pimote-folders/SKILL.md');
      expect(agents).toContain('memory.md');
      // No tool listing — tools are injected.
      expect(agents).not.toMatch(/pimote_\w/);

      await expect(stat(join(root, 'memory.md'))).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('leaves an existing AGENTS.md untouched and never merges', async () => {
    const { root, cleanup } = await makeManagerRoot();
    try {
      const userContent = '# My manager\n\nuser-owned content\n';
      await writeFile(join(root, 'AGENTS.md'), userContent, 'utf8');

      await seedManagerRoot(root);

      await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(userContent);
      // memory.md was absent and is still seeded alongside.
      await expect(stat(join(root, 'memory.md'))).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('leaves an existing memory.md untouched', async () => {
    const { root, cleanup } = await makeManagerRoot();
    try {
      const userNotes = 'user memory notes\n';
      await writeFile(join(root, 'memory.md'), userNotes, 'utf8');

      await seedManagerRoot(root);

      await expect(readFile(join(root, 'memory.md'), 'utf8')).resolves.toBe(userNotes);
      // AGENTS.md was absent and is seeded.
      const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
      expect(agents.trim().length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('propagates filesystem errors when the manager root is unusable', async () => {
    const { root, cleanup } = await makeManagerRoot();
    try {
      const fileRoot = join(root, 'not-a-folder');
      await writeFile(fileRoot, 'user-owned\n');
      await expect(seedManagerRoot(fileRoot)).rejects.toThrow();
      await expect(readFile(fileRoot, 'utf8')).resolves.toBe('user-owned\n');
    } finally {
      await cleanup();
    }
  });

  it('changes nothing when both files are present', async () => {
    const { root, cleanup } = await makeManagerRoot();
    try {
      const userContent = 'user agents\n';
      const userNotes = 'user memory\n';
      await writeFile(join(root, 'AGENTS.md'), userContent, 'utf8');
      await writeFile(join(root, 'memory.md'), userNotes, 'utf8');

      await seedManagerRoot(root);

      await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(userContent);
      await expect(readFile(join(root, 'memory.md'), 'utf8')).resolves.toBe(userNotes);
    } finally {
      await cleanup();
    }
  });
});
