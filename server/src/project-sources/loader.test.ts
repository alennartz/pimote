import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectSources } from './loader.js';

let sourcesDir: string;

beforeEach(async () => {
  sourcesDir = await mkdtemp(join(tmpdir(), 'project-sources-test-'));
});

afterEach(async () => {
  await rm(sourcesDir, { recursive: true, force: true });
});

async function writeModule(name: string, code: string): Promise<void> {
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(join(sourcesDir, name), code, 'utf8');
}

describe('loadProjectSources()', () => {
  it('collects sources and creators from every module in the directory', async () => {
    await writeModule(
      'a.mjs',
      [
        `export const sources = [{ id: 'source-a', list: async () => [] }];`,
        `export const creators = [{ id: 'creator-a', describe: () => ({ label: 'A', paramSchema: {} }), create: async () => ({ path: '/x' }) }];`,
      ].join('\n'),
    );
    await writeModule(`b.mjs`, `export const sources = [{ id: 'source-b', list: async () => [] }];`);

    const { sources, creators } = await loadProjectSources(sourcesDir);

    expect(sources.map((s) => s.id).sort()).toEqual(['source-a', 'source-b']);
    expect(creators.map((c) => c.id)).toEqual(['creator-a']);
  });

  it('skips a module that throws while loading and continues with the rest', async () => {
    await writeModule(`good.mjs`, `export const sources = [{ id: 'good', list: async () => [] }];`);
    await writeModule(`broken-throw.mjs`, `throw new Error('boom');\nexport const sources = [];`);
    await writeModule(`broken-syntax.mjs`, `export const = ;`);

    const { sources } = await loadProjectSources(sourcesDir);

    expect(sources.map((s) => s.id)).toEqual(['good']);
  });

  it('loads a TypeScript module exporting sources alongside the .mjs modules', async () => {
    await writeModule('a.mjs', `export const sources = [{ id: 'source-a', list: async () => [] }];`);
    await writeModule('ts-source.ts', `export const sources = [{ id: 'source-ts', list: async () => [] }];`);

    const { sources } = await loadProjectSources(sourcesDir);

    expect(sources.map((s) => s.id).sort()).toEqual(['source-a', 'source-ts']);
  });

  it('ignores non-module files', async () => {
    await writeModule('README.txt', 'not a module');
    await writeModule('notes.json', '{ "not": "a module" }');

    const { sources, creators } = await loadProjectSources(sourcesDir);

    expect(sources).toEqual([]);
    expect(creators).toEqual([]);
  });

  it('returns empty results for a missing directory', async () => {
    const { sources, creators } = await loadProjectSources(join(sourcesDir, 'does-not-exist'));

    expect(sources).toEqual([]);
    expect(creators).toEqual([]);
  });
});
