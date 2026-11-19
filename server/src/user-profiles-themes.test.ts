import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

    await expect(profiles.setSelectedTheme('alice', 'dracula/dracula')).resolves.toBe(true);
    expect(profiles.selectedTheme('alice')).toBe('dracula/dracula');

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.selectedTheme('alice')).toBe('dracula/dracula');
  });

  it('clears an override with null without deleting the user profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.setSelectedTheme('alice', 'pimote/dark');
    await expect(profiles.setSelectedTheme('alice', null)).resolves.toBe(true);
    expect(profiles.selectedTheme('alice')).toBeNull();
  });

  it('does not change another user when one profile changes theme', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.setSelectedTheme('alice', 'pimote/dark');
    await profiles.setSelectedTheme('bob', 'nord/nord');

    expect(profiles.selectedTheme('alice')).toBe('pimote/dark');
    expect(profiles.selectedTheme('bob')).toBe('nord/nord');
  });

  it('keeps theme selections in the existing profile document shape', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();
    await profiles.setSelectedTheme('alice', 'pimote/dark');

    const raw = JSON.parse(await readFile(path, 'utf8')) as { users: { alice: { selectedThemeId: string } } };
    expect(raw.users.alice.selectedThemeId).toBe('pimote/dark');

    await writeFile(path, JSON.stringify({ version: 1, users: { alice: { sessions: [], selectedThemeId: null } } }), 'utf8');
    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.selectedTheme('alice')).toBeNull();
  });
});
