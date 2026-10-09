import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManagerExtension } from './attachment.js';

// The manager extension attachment rule (plan: manager-lifecycle):
// `loadManagerExtension(session) = canonical(session.cwd) === canonical(config.managerRoot)`.
// Canonical identity is the real path; equality, not containment.

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'manager-attachment-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('loadManagerExtension()', () => {
  it('attaches the manager extension for a session rooted at the manager root', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const managerRoot = join(root, 'manager-home');
      await mkdir(managerRoot);

      await expect(loadManagerExtension({ cwd: managerRoot }, { managerRoot })).resolves.toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('does not attach for a session in an unrelated folder', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const managerRoot = join(root, 'manager-home');
      const other = join(root, 'project');
      await mkdir(managerRoot);
      await mkdir(other);

      await expect(loadManagerExtension({ cwd: other }, { managerRoot })).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('does not attach for a session inside the manager root — equality, not containment', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const managerRoot = join(root, 'manager-home');
      const below = join(managerRoot, 'subfolder');
      await mkdir(below, { recursive: true });

      await expect(loadManagerExtension({ cwd: below }, { managerRoot })).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('attaches when the session cwd is a symlink alias of the manager root — canonical identity', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const managerRoot = join(root, 'manager-home');
      await mkdir(managerRoot);
      const alias = join(root, 'alias');
      await symlink(managerRoot, alias);

      await expect(loadManagerExtension({ cwd: alias }, { managerRoot })).resolves.toBe(true);
    } finally {
      await cleanup();
    }
  });
});
