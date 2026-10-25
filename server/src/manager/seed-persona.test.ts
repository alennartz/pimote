import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedPersonaFolder, MEMORY_STUB } from './seed.js';
import { parsePersonaFrontMatter } from '../folder-model/marker.js';

let tempDir: string;
let rootDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'seed-persona-test-'));
  rootDir = join(tempDir, 'root');
  await mkdir(rootDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('seedPersonaFolder', () => {
  it('creates the folder under root and returns its canonical path', async () => {
    const canonical = await seedPersonaFolder(rootDir, 'ada', 'Research assistant', 'You are Ada.');

    expect(canonical).toBe(await realpath(join(rootDir, 'ada')));
    expect(await readFile(join(canonical, 'AGENTS.md'), 'utf8')).toContain('You are Ada.');
  });

  it('returns the canonical path when the root is a symlink alias', async () => {
    const aliasRoot = join(tempDir, 'root-alias');
    await symlink(rootDir, aliasRoot);

    const canonical = await seedPersonaFolder(aliasRoot, 'ada', 'Research assistant', 'You are Ada.');

    expect(canonical).toBe(join(rootDir, 'ada'));
    expect(canonical).toBe(await realpath(join(aliasRoot, 'ada')));
  });

  it('seeds AGENTS.md with a persona marker carrying name and description, body personaText', async () => {
    const canonical = await seedPersonaFolder(rootDir, 'ada', 'Research assistant', 'You are Ada.');
    const content = await readFile(join(canonical, 'AGENTS.md'), 'utf8');

    expect(parsePersonaFrontMatter(content)).toEqual({ name: 'ada', description: 'Research assistant' });
    expect(content).toContain('You are Ada.');
  });

  it('round-trips persona marker values that need YAML quoting', async () => {
    const name = 'Ada: the "first"';
    const description = 'Research — plans, specs';
    const canonical = await seedPersonaFolder(rootDir, name, description, 'Body.');
    const content = await readFile(join(canonical, 'AGENTS.md'), 'utf8');

    expect(parsePersonaFrontMatter(content)).toEqual({ name, description });
  });

  it('always writes AGENTS.md and memory.md even when personaText is empty', async () => {
    const canonical = await seedPersonaFolder(rootDir, 'ada', 'Research assistant', '');
    const agents = await readFile(join(canonical, 'AGENTS.md'), 'utf8');

    expect(parsePersonaFrontMatter(agents)).toEqual({ name: 'ada', description: 'Research assistant' });
    expect(await readFile(join(canonical, 'memory.md'), 'utf8')).toBe(MEMORY_STUB);
  });

  it('writes the memory.md stub beside AGENTS.md when personaText is given', async () => {
    const canonical = await seedPersonaFolder(rootDir, 'ada', 'Research assistant', 'You are Ada.');

    expect(await readFile(join(canonical, 'memory.md'), 'utf8')).toBe(MEMORY_STUB);
  });

  it('refuses an existing destination and leaves it untouched', async () => {
    // A free destination seeds fine — the refusal contract below runs against
    // a live seam, not a stub that rejects everything.
    await seedPersonaFolder(rootDir, 'fresh', 'Research assistant', 'You are Ada.');
    await mkdir(join(rootDir, 'ada'));
    await writeFile(join(rootDir, 'ada', 'keep.txt'), 'mine', 'utf8');

    await expect(seedPersonaFolder(rootDir, 'ada', 'Research assistant', 'You are Ada.')).rejects.toThrow();
    expect(await readFile(join(rootDir, 'ada', 'keep.txt'), 'utf8')).toBe('mine');
    await expect(readFile(join(rootDir, 'ada', 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});
