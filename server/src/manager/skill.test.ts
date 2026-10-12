import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePimoteFoldersSkill, PIMOTE_FOLDERS_SKILL_NAME } from './skill.js';

// The server-provided pimote-folders skill (DR-062): embedded markdown,
// materialized idempotently, rewritten on drift so version upgrades
// propagate — the static-report provision pattern.

describe('ensurePimoteFoldersSkill()', () => {
  async function makeSandbox() {
    const dir = await mkdtemp(join(tmpdir(), 'pimote-skill-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('materializes SKILL.md and its references, with valid front matter', async () => {
    const sandbox = await makeSandbox();
    try {
      const skillPath = await ensurePimoteFoldersSkill(sandbox.dir);

      expect(skillPath).toBe(join(sandbox.dir, PIMOTE_FOLDERS_SKILL_NAME, 'SKILL.md'));
      const skill = await readFile(skillPath, 'utf8');
      // Agent-skills front matter: name and a routing description.
      expect(skill.startsWith(`---\nname: ${PIMOTE_FOLDERS_SKILL_NAME}\ndescription: `)).toBe(true);

      for (const reference of ['model.md', 'recipes.md']) {
        await expect(stat(join(sandbox.dir, PIMOTE_FOLDERS_SKILL_NAME, 'references', reference))).resolves.toBeTruthy();
      }
      // The map points at both references.
      expect(skill).toContain('references/model.md');
      expect(skill).toContain('references/recipes.md');
    } finally {
      await sandbox.cleanup();
    }
  });

  it('states the general leaf rule and the four kinds, not a persona-specific one', async () => {
    const sandbox = await makeSandbox();
    try {
      await ensurePimoteFoldersSkill(sandbox.dir);
      const model = await readFile(join(sandbox.dir, PIMOTE_FOLDERS_SKILL_NAME, 'references', 'model.md'), 'utf8');
      const recipes = await readFile(join(sandbox.dir, PIMOTE_FOLDERS_SKILL_NAME, 'references', 'recipes.md'), 'utf8');

      expect(model).toContain('code or persona');
      expect(model).toContain('leaf');
      for (const kind of ['"code"', '"persona"', '"code-hub"', '"persona-hub"']) {
        expect(recipes).toContain(kind);
      }
      // The anti-pattern that motivated the skill: nesting real folders.
      expect(recipes).toContain('Nest a real persona folder');
    } finally {
      await sandbox.cleanup();
    }
  });

  it('rewrites on drift and stays read-only when content matches', async () => {
    const sandbox = await makeSandbox();
    try {
      const skillPath = await ensurePimoteFoldersSkill(sandbox.dir);
      // Drift: a user edit is replaced by the shipped content on the next
      // ensure call — upgrades propagate.
      await writeFile(skillPath, 'user-mangled content\n', 'utf8');
      await ensurePimoteFoldersSkill(sandbox.dir);
      const after = await readFile(skillPath, 'utf8');
      expect(after.startsWith('---')).toBe(true);
      expect(after).not.toContain('user-mangled');

      // Idempotent re-run: the same call succeeds and keeps the content.
      await ensurePimoteFoldersSkill(sandbox.dir);
      await expect(readFile(skillPath, 'utf8')).resolves.toBe(after);
    } finally {
      await sandbox.cleanup();
    }
  });
});
