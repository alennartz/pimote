import { describe, expect, it, vi } from 'vitest';
import { createUpdateChecker, type UpdateStatus } from './update-check.js';

const newerStatus: UpdateStatus = {
  currentVersion: '1.0.0',
  latestVersion: '1.2.0',
  releaseUrl: 'https://github.com/alennartz/pimote/releases/tag/pimote-v1.2.0',
};

describe('createUpdateChecker', () => {
  it('returns the newer registry version with the canonical release URL', async () => {
    const fetchLatestVersion = vi.fn(async () => '1.2.0');
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchLatestVersion });

    await expect(checker.getStatus()).resolves.toEqual(newerStatus);
    expect(fetchLatestVersion).toHaveBeenCalledOnce();
  });

  it('returns null when the published version equals the running version', async () => {
    const checker = createUpdateChecker({ currentVersion: '1.2.0', fetchLatestVersion: async () => '1.2.0' });

    await expect(checker.getStatus()).resolves.toBeNull();
  });

  it('returns null when the running version is ahead of the registry', async () => {
    const checker = createUpdateChecker({ currentVersion: '2.0.0', fetchLatestVersion: async () => '1.9.9' });

    await expect(checker.getStatus()).resolves.toBeNull();
  });

  it('swallows registry failures and resolves null on a cold cache', async () => {
    const checker = createUpdateChecker({
      currentVersion: '1.0.0',
      fetchLatestVersion: async () => {
        throw new Error('registry unavailable');
      },
    });

    await expect(checker.getStatus()).resolves.toBeNull();
  });

  it('returns the cached status when a refresh fails after the TTL', async () => {
    let now = 0;
    let calls = 0;
    const fetchLatestVersion = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return '1.2.0';
      throw new Error('registry unavailable');
    });
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchLatestVersion, now: () => now, ttlMs: 100 });

    await expect(checker.getStatus()).resolves.toEqual(newerStatus);
    now = 100;
    await expect(checker.getStatus()).resolves.toEqual(newerStatus);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('does not fetch again while the cached value is within the TTL', async () => {
    let now = 0;
    const fetchLatestVersion = vi.fn(async () => '1.2.0');
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchLatestVersion, now: () => now, ttlMs: 100 });

    await expect(checker.getStatus()).resolves.toEqual(newerStatus);
    now = 99;
    await expect(checker.getStatus()).resolves.toEqual(newerStatus);

    expect(fetchLatestVersion).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent cold-cache calls into one registry request', async () => {
    let release!: (version: string) => void;
    const fetchGate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fetchLatestVersion = vi.fn(() => fetchGate);
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchLatestVersion });

    const first = checker.getStatus();
    const second = checker.getStatus();
    expect(fetchLatestVersion).toHaveBeenCalledOnce();

    release('1.2.0');
    await expect(Promise.all([first, second])).resolves.toEqual([newerStatus, newerStatus]);
  });
});
