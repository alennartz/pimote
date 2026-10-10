import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs/promises', () => fs);

import { CONFIG_PATH, loadConfig, managerRootPlacementError } from './config.js';
import { PIMOTE_STATE_DIR } from './paths.js';

function configJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ roots: ['/workspace'], ...fields });
}

describe('loadConfig — managerRoot', () => {
  beforeEach(() => {
    fs.readFile.mockReset();
  });

  it('defaults to the state-local manager directory when managerRoot is absent', async () => {
    fs.readFile.mockResolvedValue(configJson({}));

    await expect(loadConfig()).resolves.toMatchObject({ managerRoot: join(PIMOTE_STATE_DIR, 'manager') });
  });

  it('expands a bare tilde to the home directory', async () => {
    fs.readFile.mockResolvedValue(configJson({ managerRoot: '~' }));

    await expect(loadConfig()).resolves.toMatchObject({ managerRoot: homedir() });
  });

  it('expands a leading ~/ path to the home directory', async () => {
    fs.readFile.mockResolvedValue(configJson({ managerRoot: '~/manager' }));

    await expect(loadConfig()).resolves.toMatchObject({ managerRoot: join(homedir(), 'manager') });
  });

  it('keeps an explicit absolute path unchanged', async () => {
    fs.readFile.mockResolvedValue(configJson({ managerRoot: '/srv/pimote/manager' }));

    await expect(loadConfig()).resolves.toMatchObject({ managerRoot: '/srv/pimote/manager' });
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['a boolean', true],
    ['an array', ['/srv/manager']],
    ['an object', { path: '/srv/manager' }],
    ['an empty string', ''],
  ])('rejects managerRoot when it is %s', async (_label, value) => {
    fs.readFile.mockResolvedValue(configJson({ managerRoot: value }));

    await expect(loadConfig()).rejects.toThrow(`Config "managerRoot" must be a non-empty string in ${CONFIG_PATH}`);
  });
});

describe('loadConfig — roots behavior is unchanged', () => {
  beforeEach(() => {
    fs.readFile.mockReset();
  });

  it('passes root strings through verbatim without tilde expansion', async () => {
    fs.readFile.mockResolvedValue(configJson({ roots: ['~/projects', '/abs/work'], managerRoot: '/srv/manager' }));

    const config = await loadConfig();
    expect(config.roots).toEqual(['~/projects', '/abs/work']);
    expect(config.managerRoot).toBe('/srv/manager');
  });

  it('keeps the existing roots validation error and its precedence over managerRoot', async () => {
    fs.readFile.mockResolvedValue(JSON.stringify({ roots: [], managerRoot: 42 }));

    await expect(loadConfig()).rejects.toThrow(`Config "roots" must be a non-empty array of strings in ${CONFIG_PATH}`);
  });

  it('still rejects non-string roots members', async () => {
    fs.readFile.mockResolvedValue(JSON.stringify({ roots: ['/ok', 7], managerRoot: '~' }));

    await expect(loadConfig()).rejects.toThrow(`Config "roots" must be a non-empty array of strings in ${CONFIG_PATH}`);
  });

  it('still requires roots even when managerRoot is valid', async () => {
    fs.readFile.mockResolvedValue(JSON.stringify({ managerRoot: '~' }));

    await expect(loadConfig()).rejects.toThrow(`Config "roots" must be a non-empty array of strings in ${CONFIG_PATH}`);
  });
});

// Placement guard for the manager root (owner ruling on review findings 1 and
// 10, split by harm): a manager root that is or contains the home directory
// fails boot — the seeded manager persona AGENTS.md would leak into every pi
// session below it as ancestor context. A manager root inside or equal to a
// scan root is legal: the listing assembly drops its row.
describe('managerRootPlacementError', () => {
  const home = '/home/user';

  it('accepts a manager root away from the home tree, including one nested in a scan root', () => {
    expect(managerRootPlacementError('/srv/pimote/manager', home)).toBeNull();
    expect(managerRootPlacementError('/srv/work/manager', home)).toBeNull();
    expect(managerRootPlacementError('/srv/work', home)).toBeNull();
  });

  it('rejects the home directory as manager root', () => {
    expect(managerRootPlacementError(home, home)).toMatch(/must not be or contain the home directory/);
  });

  it('rejects an ancestor of the home directory', () => {
    expect(managerRootPlacementError('/home', home)).toMatch(/must not be or contain the home directory/);
  });

  it('does not mistake a sibling sharing only the prefix for containment', () => {
    expect(managerRootPlacementError('/home/user-2', home)).toBeNull();
  });
});
