import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFolderSources, resolveSourcesDir, sdkRuntimeAliases } from './loader.js';

let sourcesDir: string;

beforeEach(async () => {
  sourcesDir = await mkdtemp(join(tmpdir(), 'folder-sources-test-'));
});

afterEach(async () => {
  await rm(sourcesDir, { recursive: true, force: true });
});

async function writeModule(name: string, code: string): Promise<void> {
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(join(sourcesDir, name), code, 'utf8');
}

describe('loadFolderSources()', () => {
  it('collects sources and creators from every module in the directory', async () => {
    await writeModule(
      'a.mjs',
      [
        `export const sources = [{ id: 'source-a', list: async () => [] }];`,
        `export const creators = [{ id: 'creator-a', describe: () => ({ label: 'A', paramSchema: {} }), create: async () => ({ path: '/x' }) }];`,
      ].join('\n'),
    );
    await writeModule(`b.mjs`, `export const sources = [{ id: 'source-b', list: async () => [] }];`);

    const { sources, creators } = await loadFolderSources(sourcesDir);

    expect(sources.map((s) => s.id).sort()).toEqual(['source-a', 'source-b']);
    expect(creators.map((c) => c.id)).toEqual(['creator-a']);
  });

  it('skips a module that throws while loading and continues with the rest', async () => {
    await writeModule(`good.mjs`, `export const sources = [{ id: 'good', list: async () => [] }];`);
    await writeModule(`broken-throw.mjs`, `throw new Error('boom');\nexport const sources = [];`);
    await writeModule(`broken-syntax.mjs`, `export const = ;`);

    const { sources } = await loadFolderSources(sourcesDir);

    expect(sources.map((s) => s.id)).toEqual(['good']);
  });

  it('loads a TypeScript module exporting sources alongside the .mjs modules', async () => {
    await writeModule('a.mjs', `export const sources = [{ id: 'source-a', list: async () => [] }];`);
    await writeModule('ts-source.ts', `export const sources = [{ id: 'source-ts', list: async () => [] }];`);

    const { sources } = await loadFolderSources(sourcesDir);

    expect(sources.map((s) => s.id).sort()).toEqual(['source-a', 'source-ts']);
  });

  it('ignores non-module files', async () => {
    await writeModule('README.txt', 'not a module');
    await writeModule('notes.json', '{ "not": "a module" }');

    const { sources, creators } = await loadFolderSources(sourcesDir);

    expect(sources).toEqual([]);
    expect(creators).toEqual([]);
  });

  it('returns empty results for a missing directory', async () => {
    const { sources, creators } = await loadFolderSources(join(sourcesDir, 'does-not-exist'));

    expect(sources).toEqual([]);
    expect(creators).toEqual([]);
  });

  it('resolves @pimote/sdk imports inside user modules to the runtime copy', async () => {
    const aliases = sdkRuntimeAliases();
    const probeCode = [`import { answerActivity } from '@pimote/sdk/activity';`, `export const sources = [{ id: typeof answerActivity, list: async () => [] }];`].join('\n');
    await writeModule('sdk-probe.ts', probeCode);

    const { sources } = await loadFolderSources(sourcesDir);

    // In a checkout whose SDK dist is not built the alias target file is
    // absent, jiti fails to load the probe, and the loader skips the module.
    if (!aliases['@pimote/sdk/activity'] || !existsSync(aliases['@pimote/sdk/activity'])) {
      expect(sources).toEqual([]);
      return;
    }
    expect(sources.map((s) => s.id)).toEqual(['function']);
  });
});

describe('resolveSourcesDir()', () => {
  it('prefers an explicitly configured directory unchanged', async () => {
    const configured = join(sourcesDir, 'configured');
    const preferred = join(sourcesDir, 'preferred');
    const legacy = join(sourcesDir, 'legacy');

    await expect(resolveSourcesDir(configured, { preferred, legacy })).resolves.toBe(configured);
  });

  it('uses the preferred directory when it exists', async () => {
    const preferred = join(sourcesDir, 'preferred');
    const legacy = join(sourcesDir, 'legacy');
    await mkdir(preferred, { recursive: true });

    await expect(resolveSourcesDir(undefined, { preferred, legacy })).resolves.toBe(preferred);
  });

  it('falls back to the legacy directory when the preferred one is absent', async () => {
    const preferred = join(sourcesDir, 'preferred');
    const legacy = join(sourcesDir, 'legacy');
    await mkdir(legacy, { recursive: true });

    await expect(resolveSourcesDir(undefined, { preferred, legacy })).resolves.toBe(legacy);
  });
});

describe('sdkRuntimeAliases()', () => {
  it('maps every SDK specifier to a file of the runtime SDK package', () => {
    const aliases = sdkRuntimeAliases();
    expect(Object.keys(aliases).sort()).toEqual(['@pimote/sdk', '@pimote/sdk/activity', '@pimote/sdk/folders', '@pimote/sdk/panels'].sort());
    for (const target of Object.values(aliases)) {
      expect(target).toMatch(/(@pimote\/sdk|packages\/sdk)\//);
      expect(target.endsWith('.js')).toBe(true);
    }
  });
});
