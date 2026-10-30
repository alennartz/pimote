import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPimoteExtensionHost, type PimoteConfiguredPackage, type PimotePackageManager } from './index.js';

let extensionDirectory: string;

beforeEach(async () => {
  extensionDirectory = await mkdtemp(join(tmpdir(), 'pimote-extensions-test-'));
});

afterEach(async () => {
  await rm(extensionDirectory, { recursive: true, force: true });
});

async function writeExtension(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
}

function packageManager(packages: readonly PimoteConfiguredPackage[]): PimotePackageManager {
  return {
    listConfiguredPackages: () => packages,
    getInstalledPath: (source, scope) => packages.find((pkg) => pkg.source === source && pkg.scope === scope)?.installedPath,
  };
}

function sourceCode(id: string, settingsPath: string): string {
  return [
    'export default (context) => {',
    `  context.folders.registerSource({ id: ${JSON.stringify(id)}, list: async () => [] });`,
    `  context.settings.registerFile(${JSON.stringify(settingsPath)});`,
    '};',
  ].join('\n');
}

describe('Pimote extension discovery', () => {
  it('loads direct JavaScript/TypeScript modules and extension directories in discovery order', async () => {
    const direct = join(extensionDirectory, '01-direct.mjs');
    const typed = join(extensionDirectory, '02-typed.ts');
    const directoryEntry = join(extensionDirectory, '03-directory', 'entry.mjs');
    await writeExtension(direct, sourceCode('direct', './direct.md'));
    await writeExtension(typed, sourceCode('typed', './typed.md'));
    await writeExtension(join(extensionDirectory, '03-directory', 'package.json'), JSON.stringify({ name: 'directory-extension', main: './entry.mjs' }));
    await writeExtension(directoryEntry, sourceCode('directory', './directory.md'));

    const host = createPimoteExtensionHost({ extensionDirectory });
    const registry = await host.start();

    expect(registry.sources.map((source) => source.id)).toEqual(['direct', 'typed', 'directory']);
    expect(registry.settingsFiles).toEqual([
      resolve(extensionDirectory, 'direct.md'),
      resolve(extensionDirectory, 'typed.md'),
      resolve(extensionDirectory, '03-directory', 'directory.md'),
    ]);
    await host.shutdown();
  });

  it('keeps a registered missing settings file in the runtime registry', async () => {
    await writeExtension(join(extensionDirectory, 'missing.mjs'), sourceCode('missing', './not-created.md'));

    const host = createPimoteExtensionHost({ extensionDirectory });
    const registry = await host.start();

    expect(registry.settingsFiles).toEqual([resolve(extensionDirectory, 'not-created.md')]);
    await host.shutdown();
  });
});

describe('Pimote package adaptation', () => {
  it('loads only user package pimote.extensions entries, not pi.extensions or project packages', async () => {
    const userPackage = join(extensionDirectory, 'user-package');
    const projectPackage = join(extensionDirectory, 'project-package');
    await writeExtension(join(userPackage, 'src', 'pimote.mjs'), sourceCode('user-pimote', './user.md'));
    await writeExtension(join(userPackage, 'src', 'pi-only.mjs'), sourceCode('must-not-load-pi', './pi.md'));
    await writeExtension(join(projectPackage, 'src', 'pimote.mjs'), sourceCode('must-not-load-project', './project.md'));
    await writeFile(
      join(userPackage, 'package.json'),
      JSON.stringify({
        name: 'user-package',
        pi: { extensions: ['./src/pi-only.mjs'] },
        pimote: { extensions: ['./src/pimote.mjs'] },
      }),
      'utf8',
    );
    await writeFile(join(projectPackage, 'package.json'), JSON.stringify({ name: 'project-package', pimote: { extensions: ['./src/pimote.mjs'] } }), 'utf8');

    const host = createPimoteExtensionHost({
      extensionDirectory,
      packageManager: packageManager([
        { source: 'npm:user-package', scope: 'user', filtered: false, installedPath: userPackage },
        { source: 'npm:project-package', scope: 'project', filtered: false, installedPath: projectPackage },
      ]),
    });
    const registry = await host.start();

    expect(registry.sources.map((source) => source.id)).toEqual(['user-pimote']);
    expect(registry.settingsFiles).toEqual([resolve(userPackage, 'src', 'user.md')]);
    await host.shutdown();
  });
});

describe('Pimote extension lifecycle', () => {
  const stateKey = '__pimoteExtensionLifecycleContractTest';

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[stateKey];
  });

  it('awaits shutdown handlers, invalidates old registrations, and replaces the registry on reload', async () => {
    (globalThis as Record<string, unknown>)[stateKey] = { runs: 0, shutdowns: 0, contexts: [] };
    await writeExtension(
      join(extensionDirectory, 'lifecycle.mjs'),
      [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        'export default (context) => {',
        '  state.runs += 1;',
        '  state.contexts.push(context);',
        '  context.folders.registerSource({ id: `lifecycle-${state.runs}`, list: async () => [] });',
        "  context.on('shutdown', () => { state.shutdowns += 1; });",
        '};',
      ].join('\n'),
    );

    const host = createPimoteExtensionHost({ extensionDirectory });
    const first = await host.start();
    const state = (
      globalThis as Record<
        string,
        {
          runs: number;
          shutdowns: number;
          contexts: Array<{ folders: { registerSource(source: unknown): void }; settings: { registerFile(path: string): void } }>;
        }
      >
    )[stateKey];
    expect(first.sources.map((source) => source.id)).toEqual(['lifecycle-1']);
    expect(state.runs).toBe(1);

    const oldContext = state.contexts[0];
    const second = await host.reload();
    oldContext.folders.registerSource({ id: 'stale-registration', list: async () => [] });
    oldContext.settings.registerFile('./stale-settings.md');

    expect(state.shutdowns).toBe(1);
    expect(state.runs).toBe(2);
    expect(second.sources.map((source) => source.id)).toEqual(['lifecycle-2']);
    expect(host.getRegistry().sources.map((source) => source.id)).not.toContain('stale-registration');
    expect(host.getRegistry().settingsFiles).not.toContain(resolve(extensionDirectory, 'stale-settings.md'));

    await host.shutdown();
    expect(state.shutdowns).toBe(2);
  });

  it('serializes concurrent reloads into distinct fresh runtimes', async () => {
    (globalThis as Record<string, unknown>)[stateKey] = { runs: 0, shutdowns: 0, contexts: [] };
    await writeExtension(
      join(extensionDirectory, 'serialized.mjs'),
      [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        'export default (context) => {',
        '  state.runs += 1;',
        '  context.folders.registerSource({ id: `serialized-${state.runs}`, list: async () => [] });',
        "  context.on('shutdown', () => { state.shutdowns += 1; });",
        '};',
      ].join('\n'),
    );

    const host = createPimoteExtensionHost({ extensionDirectory });
    await host.start();
    const [first, second] = await Promise.all([host.reload(), host.reload()]);
    const state = (globalThis as Record<string, { runs: number; shutdowns: number }>)[stateKey];

    expect(state.runs).toBe(3);
    expect(state.shutdowns).toBe(2);
    expect(first.sources.map((source) => source.id)).toEqual(['serialized-2']);
    expect(second.sources.map((source) => source.id)).toEqual(['serialized-3']);
  });

  it('isolates module failures, reports diagnostics, and still replaces a failed runtime', async () => {
    const good = join(extensionDirectory, 'good.mjs');
    const brokenLoad = join(extensionDirectory, 'broken-load.mjs');
    const brokenFactory = join(extensionDirectory, 'broken-factory.mjs');
    await writeExtension(good, sourceCode('good', './good.md'));
    await writeExtension(brokenLoad, "throw new Error('broken load');");
    await writeExtension(brokenFactory, "export default () => { throw new Error('broken factory'); };");

    const host = createPimoteExtensionHost({ extensionDirectory });
    const first = await host.start();
    expect(first.sources.map((source) => source.id)).toEqual(['good']);
    expect(first.diagnostics).toHaveLength(2);
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        { path: brokenLoad, message: expect.stringContaining('broken load') },
        { path: brokenFactory, message: expect.stringContaining('broken factory') },
      ]),
    );

    await rm(good);
    const second = await host.reload();
    expect(second.sources).toEqual([]);
    expect(second.diagnostics).toHaveLength(2);
    expect(second.diagnostics).toEqual(
      expect.arrayContaining([
        { path: brokenLoad, message: expect.stringContaining('broken load') },
        { path: brokenFactory, message: expect.stringContaining('broken factory') },
      ]),
    );
    expect(host.getRegistry()).toBe(second);
  });
});
