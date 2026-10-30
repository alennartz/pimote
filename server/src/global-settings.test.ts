import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GlobalSettingsCatalog } from './global-settings.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'global-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const options = () => ({ home: dir, agentDir: join(dir, 'pi-agent'), configPath: join(dir, 'xdg/pimote/config.json') });

describe('Global settings manifest', () => {
  it('orders effective built-ins, configured paths, then extension registrations', async () => {
    const catalog = new GlobalSettingsCatalog({
      ...options(),
      settingsFiles: ['first.md', 'second.txt'],
      extensionFiles: [join(dir, 'modules/ext.md')],
    });
    const { files } = await catalog.snapshot();
    expect(files.map((file) => file.path)).toEqual([
      join(dir, 'pi-agent/AGENTS.md'),
      join(dir, 'pi-agent/settings.json'),
      join(dir, 'xdg/pimote/config.json'),
      join(dir, 'xdg/pimote/first.md'),
      join(dir, 'xdg/pimote/second.txt'),
      join(dir, 'modules/ext.md'),
    ]);
  });

  it('deduplicates existing canonical targets by first occurrence', async () => {
    await mkdir(join(dir, 'pi-agent'), { recursive: true });
    await writeFile(join(dir, 'pi-agent/AGENTS.md'), 'instructions');
    await symlink(join(dir, 'pi-agent/AGENTS.md'), join(dir, 'alias.md'));
    const { files } = await new GlobalSettingsCatalog({ ...options(), settingsFiles: [join(dir, 'alias.md')] }).snapshot();
    expect(files.filter((file) => file.path === join(dir, 'alias.md'))).toHaveLength(0);
    expect(files.filter((file) => file.path === join(dir, 'pi-agent/AGENTS.md'))).toHaveLength(1);
  });

  it('keeps missing files and expands home paths without using the process working directory', async () => {
    const { files } = await new GlobalSettingsCatalog({ ...options(), settingsFiles: ['~/missing.md', join(dir, 'absolute.txt')] }).snapshot();
    expect(files.map((file) => file.path)).toContain(join(dir, 'missing.md'));
    expect(files.map((file) => file.path)).toContain(join(dir, 'absolute.txt'));
  });

  it('uses basenames for unique tabs and parent segments for colliding basenames', async () => {
    const { files } = await new GlobalSettingsCatalog({ ...options(), settingsFiles: ['a/shared.md', 'b/shared.md', 'unique.txt'] }).snapshot();
    const shared = files.filter((file) => basename(file.path) === 'shared.md');
    expect(shared.map((file) => file.label)).toEqual(['a/shared.md', 'b/shared.md']);
    expect(files.find((file) => basename(file.path) === 'unique.txt')?.label).toBe('unique.txt');
  });

  it('returns independent snapshots that do not retain consumer mutations', async () => {
    const catalog = new GlobalSettingsCatalog(options());
    const first = await catalog.snapshot();
    first.files.length = 0;
    expect((await catalog.snapshot()).files).toHaveLength(3);
  });
});
