import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureStaticReportSkill, STATIC_REPORT_SKILL_MARKDOWN, STATIC_REPORT_SKILL_NAME } from './skill.js';

describe('ensureStaticReportSkill', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'static-report-skill-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('materializes and refreshes the discoverable skill file', async () => {
    const skillFile = await ensureStaticReportSkill(root);

    expect(skillFile).toBe(join(root, STATIC_REPORT_SKILL_NAME, 'SKILL.md'));
    expect(await readFile(skillFile, 'utf8')).toBe(STATIC_REPORT_SKILL_MARKDOWN);

    await writeFile(skillFile, 'stale skill content', 'utf8');
    expect(await ensureStaticReportSkill(root)).toBe(skillFile);
    expect(await readFile(skillFile, 'utf8')).toBe(STATIC_REPORT_SKILL_MARKDOWN);
  });
});
