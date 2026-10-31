import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserProfiles, resolveUserName, type SessionRef } from './user-profiles.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-user-profiles-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function storePath(name = 'user-profiles.json'): string {
  return join(tempDir, name);
}

const S1: SessionRef = { sessionId: 's1', folderPath: '/home/user/project-a' };
const S2: SessionRef = { sessionId: 's2', folderPath: '/home/user/project-b' };

describe('UserProfiles — boot', () => {
  it('starts with an empty store when the profile file does not exist', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    expect(profiles.get('alice')).toEqual([]);
    expect(profiles.isFresh('alice')).toBe(true);
    expect(profiles.summaries()).toEqual([]);
  });

  it('degrades a corrupt profile file to an empty store', async () => {
    await writeFile(storePath(), '{broken json', 'utf-8');
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    expect(profiles.get('alice')).toEqual([]);
    expect(profiles.isFresh('alice')).toBe(true);
    expect(profiles.summaries()).toEqual([]);
  });
});

describe('UserProfiles — fresh semantics', () => {
  it('reports a user as fresh until its first link and never fresh again afterwards', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();

    expect(profiles.isFresh('alice')).toBe(true);
    await profiles.link('alice', S1);
    expect(profiles.isFresh('alice')).toBe(false);

    await profiles.unlink('alice', 's1');
    expect(profiles.isFresh('alice')).toBe(false);

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.isFresh('alice')).toBe(false);
  });
});

describe('UserProfiles — link', () => {
  it('adds a session to a user profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    expect(await profiles.link('alice', S1)).toBe(true);
    expect(profiles.get('alice')).toEqual([S1]);
  });

  it('re-links a held session without duplicating it or reporting a change', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    expect(await profiles.link('alice', { ...S1 })).toBe(false);
    expect(profiles.get('alice')).toEqual([S1]);
  });

  it('re-links a held session under a new folder instead of duplicating it', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    const moved: SessionRef = { sessionId: 's1', folderPath: '/home/user/project-moved' };
    expect(await profiles.link('alice', moved)).toBe(true);
    expect(profiles.get('alice')).toEqual([moved]);
  });

  it('hands out snapshots so callers cannot mutate profile truth', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    profiles.get('alice').push(S2);
    expect(profiles.get('alice')).toEqual([S1]);
  });
});

describe('UserProfiles — unlink', () => {
  it('removes one session from one user and keeps their other sessions', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    expect(await profiles.unlink('alice', 's1')).toBe(true);
    expect(profiles.get('alice')).toEqual([S2]);
  });

  it('reports no change when the user does not hold the session', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    expect(await profiles.unlink('alice', 's2')).toBe(false);
    expect(await profiles.unlink('nobody', 's1')).toBe(false);
    expect(profiles.get('alice')).toEqual([S1]);
  });

  it("leaves another user's link to the same session in place", async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.link('bob', S1);
    await profiles.unlink('alice', 's1');

    expect(profiles.get('alice')).toEqual([]);
    expect(profiles.get('bob')).toEqual([S1]);
  });
});

describe('UserProfiles — unlinkAll', () => {
  it('removes a session from every user holding it and names the affected users', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.link('bob', S1);
    await profiles.link('carol', S2);

    const affected = await profiles.unlinkAll('s1');
    expect(affected).toHaveLength(2);
    expect(affected).toContain('alice');
    expect(affected).toContain('bob');

    expect(profiles.get('alice')).toEqual([S2]);
    expect(profiles.get('bob')).toEqual([]);
    expect(profiles.get('carol')).toEqual([S2]);
  });

  it('names no users when nobody holds the session', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    expect(await profiles.unlinkAll('s9')).toEqual([]);
  });
});

describe('UserProfiles — emptiness', () => {
  it('keeps a user profile listed after its last session is unlinked', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.unlink('alice', 's1');

    expect(profiles.summaries()).toEqual([{ name: 'alice', sessionCount: 0 }]);

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.summaries()).toEqual([{ name: 'alice', sessionCount: 0 }]);
    expect(reloaded.isFresh('alice')).toBe(false);
  });
});

describe('UserProfiles — gc', () => {
  it('prunes entries naming sessions outside the valid set', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.link('bob', S1);

    await profiles.gc(new Set(['s1']));

    expect(profiles.get('alice')).toEqual([S1]);
    expect(profiles.get('bob')).toEqual([S1]);
  });

  it('keeps the user key when gc empties their session list', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('alice', S1);
    await profiles.gc(new Set<string>());

    expect(profiles.get('alice')).toEqual([]);
    expect(profiles.isFresh('alice')).toBe(false);
    expect(profiles.summaries()).toEqual([{ name: 'alice', sessionCount: 0 }]);
  });
});

describe('UserProfiles — persistence', () => {
  it('survives a reload from disk', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('bob', S2);

    const reloaded = new UserProfiles(path);
    await reloaded.load();

    expect(reloaded.get('alice')).toEqual([S1]);
    expect(reloaded.get('bob')).toEqual([S2]);
    expect(reloaded.isFresh('alice')).toBe(false);
    expect(reloaded.isFresh('bob')).toBe(false);
  });

  it('round-trips a persisted document written in the storage shape', async () => {
    const path = storePath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        users: {
          alice: { sessions: [{ sessionId: 's1', folderPath: '/home/user/project-a' }] },
        },
      }),
      'utf-8',
    );

    const profiles = new UserProfiles(path);
    await profiles.load();

    expect(profiles.get('alice')).toEqual([S1]);
    expect(profiles.isFresh('alice')).toBe(false);

    await profiles.link('alice', S2);
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    expect(raw.users.alice.sessions).toHaveLength(2);
  });

  it('keys profiles by arbitrary user names without encoding them', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();
    const name = 'alice/ops (dev) é';

    await profiles.link(name, S1);

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.get(name)).toEqual([S1]);
    expect(reloaded.summaries()).toEqual([{ name, sessionCount: 1 }]);
  });
});

describe('UserProfiles — summaries', () => {
  it('lists every profile alphabetically with its session count', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    await profiles.link('carol', S1);
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.link('bob', S1);
    await profiles.unlink('bob', 's1');

    expect(profiles.summaries()).toEqual([
      { name: 'alice', sessionCount: 2 },
      { name: 'bob', sessionCount: 0 },
      { name: 'carol', sessionCount: 1 },
    ]);
  });
});

describe('resolveUserName', () => {
  it('falls back to default when the name is absent', () => {
    expect(resolveUserName(null)).toBe('default');
    expect(resolveUserName(undefined)).toBe('default');
  });

  it('falls back to default when the name is blank', () => {
    expect(resolveUserName('')).toBe('default');
    expect(resolveUserName('   ')).toBe('default');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveUserName('  bob  ')).toBe('bob');
  });

  it('caps very long names', () => {
    const long = 'a'.repeat(10_000);
    const resolved = resolveUserName(long);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.length).toBeLessThan(long.length);
  });
});
