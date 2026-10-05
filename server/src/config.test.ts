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

import { CONFIG_PATH, loadConfig } from './config.js';

function configJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ roots: ['/workspace'], ...fields });
}

describe('loadConfig — managerRoot', () => {
  beforeEach(() => {
    fs.readFile.mockReset();
  });

  it('defaults to the home directory when managerRoot is absent', async () => {
    fs.readFile.mockResolvedValue(configJson({}));

    await expect(loadConfig()).resolves.toMatchObject({ managerRoot: homedir() });
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
