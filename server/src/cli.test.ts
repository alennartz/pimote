import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let originalXdgConfigHome: string | undefined;
let originalXdgStateHome: string | undefined;

async function loadCliModule() {
  vi.resetModules();
  return import('./cli.js');
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-cli-test-'));
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
  process.env.XDG_STATE_HOME = join(tempDir, 'state');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;

  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('cli parseArgs', () => {
  it('parses init options with repeatable roots and port', async () => {
    const cli = await loadCliModule();

    expect(cli.parseArgs(['init', '--root', '~/projects', '--root', '/tmp', '--port', '3001'])).toEqual({
      command: 'init',
      roots: ['~/projects', '/tmp'],
      port: 3001,
    });
  });

  it('reports invalid port values', async () => {
    const cli = await loadCliModule();

    expect(cli.parseArgs(['--port', 'abc'])).toEqual({
      command: 'start',
      roots: [],
      port: undefined,
      error: 'Invalid port: abc',
    });
  });
});

describe('cli config initialization', () => {
  it('writes config non-interactively from CLI args and preserves unrelated settings', async () => {
    const projectRoot = join(tempDir, 'projects');
    const configDir = join(tempDir, 'config', 'pimote');
    const configPath = join(configDir, 'config.json');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ bufferSize: 42, defaultModel: 'sonnet' }, null, 2));

    const cli = await loadCliModule();
    await cli.initializeConfig({ command: 'init', cliPort: 3456, cliRoots: [projectRoot] });

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(written).toEqual({
      bufferSize: 42,
      defaultModel: 'sonnet',
      roots: [projectRoot],
      port: 3456,
    });
  });

  it('auto-creates missing config before start when roots and port are provided', async () => {
    const projectRoot = join(tempDir, 'workspace-root');
    const expectedConfigPath = join(tempDir, 'config', 'pimote', 'config.json');
    await mkdir(projectRoot, { recursive: true });

    const cli = await loadCliModule();
    const result = await cli.ensureConfigForStart({ command: 'start', roots: [projectRoot], port: 4567 });

    expect(result).toEqual({
      created: true,
      configPath: expectedConfigPath,
      port: 4567,
    });

    const written = JSON.parse(await readFile(expectedConfigPath, 'utf-8'));
    expect(written).toEqual({
      roots: [projectRoot],
      port: 4567,
    });
  });
});
