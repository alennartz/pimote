import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createPimoteExtensionHost } from './index.js';

let extensionDirectory: string;

beforeEach(async () => {
  extensionDirectory = await mkdtemp(join(tmpdir(), 'pimote-theme-extensions-'));
});

afterEach(async () => {
  await rm(extensionDirectory, { recursive: true, force: true });
});

async function writeExtension(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
}

describe('Pimote extension theme registration', () => {
  it('resolves registered theme files relative to the registering entry', async () => {
    const entry = join(extensionDirectory, 'publisher', 'index.mjs');
    await writeExtension(
      entry,
      ['export default (context) => {', "  context.themes.registerFile('./themes/night.json');", "  context.themes.registerFile('~/shared/day.json');", '};'].join('\n'),
    );

    const host = createPimoteExtensionHost({ extensionDirectory });
    await expect(host.start()).resolves.toMatchObject({
      themeFiles: [resolve(dirname(entry), 'themes/night.json'), join(homedir(), 'shared/day.json')],
    });
    await host.shutdown();
  });

  it('keeps theme registrations in deterministic discovery order', async () => {
    await writeExtension(join(extensionDirectory, '02-second.mjs'), "export default (context) => { context.themes.registerFile('./second.json'); };");
    await writeExtension(join(extensionDirectory, '01-first.mjs'), "export default (context) => { context.themes.registerFile('./first.json'); };");

    const host = createPimoteExtensionHost({ extensionDirectory });
    await expect(host.start()).resolves.toMatchObject({
      themeFiles: [resolve(extensionDirectory, 'first.json'), resolve(extensionDirectory, 'second.json')],
    });
    await host.shutdown();
  });

  it('isolates a failing theme registration while retaining other extension entries', async () => {
    await writeExtension(join(extensionDirectory, '01-good.mjs'), "export default (context) => { context.themes.registerFile('./good.json'); };");
    await writeExtension(join(extensionDirectory, '02-bad.mjs'), "export default (context) => { context.themes.registerFile(''); };");

    const host = createPimoteExtensionHost({ extensionDirectory });
    await expect(host.start()).resolves.toMatchObject({
      themeFiles: [resolve(extensionDirectory, 'good.json')],
      diagnostics: [expect.objectContaining({ path: join(extensionDirectory, '02-bad.mjs') })],
    });
    await host.shutdown();
  });

  it('invalidates old theme registrations when the host reloads', async () => {
    const entry = join(extensionDirectory, 'reload.mjs');
    await writeExtension(entry, "export default (context) => { context.themes.registerFile('./old.json'); };");
    const host = createPimoteExtensionHost({ extensionDirectory });
    await host.start();

    await writeExtension(entry, "export default (context) => { context.themes.registerFile('./new.json'); };");
    await expect(host.reload()).resolves.toMatchObject({ themeFiles: [resolve(extensionDirectory, 'new.json')] });
    expect(host.getRegistry().themeFiles).not.toContain(resolve(extensionDirectory, 'old.json'));
    await host.shutdown();
  });
});
