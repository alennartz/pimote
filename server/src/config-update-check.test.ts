import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs/promises', () => fs);

import { loadConfig } from './config.js';

function configJson(updateCheck: unknown): string {
  return JSON.stringify({ roots: ['/workspace'], updateCheck });
}

describe('loadConfig — update checking preference', () => {
  beforeEach(() => {
    fs.readFile.mockReset();
  });

  it('preserves an explicit true updateCheck setting', async () => {
    fs.readFile.mockResolvedValue(configJson(true));

    await expect(loadConfig()).resolves.toMatchObject({ updateCheck: true });
  });

  it('preserves an explicit false updateCheck setting', async () => {
    fs.readFile.mockResolvedValue(configJson(false));

    await expect(loadConfig()).resolves.toMatchObject({ updateCheck: false });
  });
});
