import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserProfiles } from './user-profiles.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-user-theme-profiles-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function storePath(): string {
  return join(tempDir, 'user-profiles.json');
}

describe('UserProfiles — theme selection', () => {
  it('starts with a null override that follows the server default', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    expect(profiles.selectedTheme('alice')).toBeNull();
  });

  it('persists a saved theme override for one user', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();

    await expect(profiles.setSelectedTheme('alice', 'pimote/dracula')).resolves.toBe(true);
    expect(profiles.selectedTheme('alice')).toBe('pimote/dracula');

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.selectedTheme('alice')).toBe('pimote/dracula');
  });

  it('migrates legacy built-in selections when loading profiles', async () => {
    const path = storePath();
    await writeFile(path, JSON.stringify({ version: 1, users: { alice: { sessions: [], selectedThemeId: 'dracula/dracula' } } }), 'utf8');
    const profiles = new UserProfiles(path);
    await profiles.load();

    expect(profiles.selectedTheme('alice')).toBe('pimote/dracula');
  });

  it('clears an override with null without deleting the user profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', { sessionId: 'one', folderPath: '/workspace' });
    await profiles.setSelectedTheme('alice', 'pimote/dark');
    await expect(profiles.setSelectedTheme('alice', null)).resolves.toBe(true);
    expect(profiles.selectedTheme('alice')).toBeNull();
    expect(profiles.get('alice')).toEqual([{ sessionId: 'one', folderPath: '/workspace' }]);
    expect(profiles.isFresh('alice')).toBe(false);
  });

  it('rejects strict theme changes for an unknown user without creating a profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await expect(profiles.setSelectedThemeStrict('alice', 'pimote/dark')).rejects.toThrow('Unknown user: alice');
    expect(profiles.summaries()).toEqual([]);
  });

  it('does not change another user when one profile changes theme', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.setSelectedTheme('alice', 'pimote/dark');
    await profiles.setSelectedTheme('bob', 'pimote/nord');

    expect(profiles.selectedTheme('alice')).toBe('pimote/dark');
    expect(profiles.selectedTheme('bob')).toBe('pimote/nord');
  });

  it('loads existing profiles without theme fields and preserves their sessions', async () => {
    const path = storePath();
    await writeFile(path, JSON.stringify({ version: 1, users: { alice: { sessions: [{ sessionId: 'one', folderPath: '/workspace' }] } } }), 'utf8');
    const profiles = new UserProfiles(path);
    await profiles.load();
    expect(profiles.selectedTheme('alice')).toBeNull();
    await profiles.setSelectedTheme('alice', 'pimote/dark');
    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.selectedTheme('alice')).toBe('pimote/dark');
    expect(reloaded.get('alice')).toEqual([{ sessionId: 'one', folderPath: '/workspace' }]);
  });
});
