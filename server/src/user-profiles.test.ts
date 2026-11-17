import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserProfiles, resolveUserName, type SessionRef, type ViewRef } from './user-profiles.js';

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

  it('keys profiles by names colliding with Object prototype members', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();

    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(await profiles.link(name, S1)).toBe(true);
      expect(profiles.get(name)).toEqual([S1]);
      expect(profiles.isFresh(name)).toBe(false);
    }
    expect(profiles.get('alice')).toEqual([]);
    expect(profiles.isFresh('alice')).toBe(true);

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(reloaded.get(name)).toEqual([S1]);
      expect(reloaded.isFresh(name)).toBe(false);
    }
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

describe('UserProfiles — order', () => {
  it('orders sessions as they were linked and appends a new one at the end', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    expect(profiles.order('alice')).toEqual(['s1', 's2']);

    await profiles.link('alice', { sessionId: 's3', folderPath: '/home/user/project-c' });
    expect(profiles.order('alice')).toEqual(['s1', 's2', 's3']);
  });

  it('seeds the order from the stored set for a document written before order existed', async () => {
    const path = storePath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        users: {
          alice: {
            sessions: [
              { sessionId: 's2', folderPath: '/home/user/project-b' },
              { sessionId: 's1', folderPath: '/home/user/project-a' },
            ],
          },
        },
      }),
      'utf-8',
    );

    const profiles = new UserProfiles(path);
    await profiles.load();

    expect(profiles.order('alice')).toEqual(['s2', 's1']);
    expect(profiles.selection('alice')).toBeNull();
    expect(profiles.orderVersion('alice')).toBe(0);
  });

  it('stores a pushed whole order and bumps the version', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    expect(await profiles.reorder('alice', ['s2', 's1'], 0)).toEqual({ accepted: true, version: 1 });
    expect(profiles.order('alice')).toEqual(['s2', 's1']);
    expect(profiles.orderVersion('alice')).toBe(1);
  });

  it('refuses a write computed against a superseded order and keeps the stored one', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.reorder('alice', ['s2', 's1'], 0);

    expect(await profiles.reorder('alice', ['s1', 's2'], 0)).toEqual({ accepted: false, version: 1 });
    expect(profiles.order('alice')).toEqual(['s2', 's1']);
  });

  it('never changes the open set: unknown ids drop and omitted members append', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    await profiles.reorder('alice', ['ghost', 's2'], 0);

    expect(profiles.order('alice')).toEqual(['s2', 's1']);
    expect(profiles.get('alice').map((ref) => ref.sessionId)).toEqual(['s1', 's2']);
  });

  it('prunes the order when a session leaves every profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    expect(await profiles.unlinkAll('s1')).toEqual(['alice']);
    expect(profiles.order('alice')).toEqual(['s2']);
  });

  it('prunes the order when gc drops a session that no longer exists', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    await profiles.gc(new Set(['s2']));
    expect(profiles.order('alice')).toEqual(['s2']);
  });

  it('survives a reload', async () => {
    const path = storePath();
    const profiles = new UserProfiles(path);
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.reorder('alice', ['s2', 's1'], 0);

    const reloaded = new UserProfiles(path);
    await reloaded.load();
    expect(reloaded.order('alice')).toEqual(['s2', 's1']);
    expect(reloaded.orderVersion('alice')).toBe(1);
  });
});

describe('UserProfiles — selection', () => {
  it('selects a session the user holds and reports the change once', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);

    expect(await profiles.select('alice', 's2')).toBe(true);
    expect(profiles.selection('alice')).toBe('s2');
    expect(await profiles.select('alice', 's2')).toBe(false);
  });

  it('refuses a session outside the user set', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);

    expect(await profiles.select('alice', 's2')).toBe(false);
    expect(profiles.selection('alice')).toBeNull();
  });

  it('clears the selection when the selected session leaves the set', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.select('alice', 's2');

    await profiles.unlinkAll('s2');
    expect(profiles.selection('alice')).toBeNull();
  });

  it('clears the selection when gc drops the selected session', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.select('alice', 's1');

    await profiles.gc(new Set<string>());
    expect(profiles.selection('alice')).toBeNull();
  });

  it('never serves a selection that a hand-edited document left stale', async () => {
    const path = storePath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        users: {
          alice: {
            sessions: [{ sessionId: 's1', folderPath: '/home/user/project-a' }],
            order: ['ghost', 's1'],
            selectedSessionId: 'ghost',
            orderVersion: 4,
          },
        },
      }),
      'utf-8',
    );

    const profiles = new UserProfiles(path);
    await profiles.load();
    expect(profiles.order('alice')).toEqual(['s1']);
    expect(profiles.selection('alice')).toBeNull();
  });
});

describe('UserProfiles — persistence failures', () => {
  it('keeps unlinkAll tolerating a failed write while gc aborts the boot sweep', async () => {
    // A file where the store's directory belongs makes every write fail.
    const blocker = join(tempDir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf-8');
    const profiles = new UserProfiles(join(blocker, 'profiles.json'));
    await profiles.load();

    await profiles.link('alice', S1);

    // Runtime mutators keep the mutation applied and report it; the throw
    // must not abort a caller mid-sweep (shared rekey, archive, delete).
    expect(await profiles.unlinkAll('s1')).toEqual(['alice']);
    expect(profiles.get('alice')).toEqual([]);

    // The boot sweep may still abort coherently on the same failure.
    await profiles.link('alice', S1);
    await expect(profiles.gc(new Set<string>())).rejects.toThrow();
  });
});

describe('UserProfiles — open child views', () => {
  const VIEW: ViewRef = { sessionId: 'child-1', rootSessionId: 's1', path: ['worker'], folderPath: '/home/user/project-a' };

  it('links a view once per root-relative path and reloads it from disk', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();

    expect(await profiles.linkView('alice', VIEW)).toBe(true);
    expect(await profiles.linkView('alice', VIEW)).toBe(false);
    expect(await profiles.linkView('alice', { ...VIEW, sessionId: 'child-2' })).toBe(true);
    expect(profiles.views('alice')).toEqual([{ ...VIEW, sessionId: 'child-2' }]);

    const reloaded = new UserProfiles(storePath());
    await reloaded.load();
    expect(reloaded.views('alice')).toEqual([{ ...VIEW, sessionId: 'child-2' }]);
  });

  it('keeps chip order and selection root-only', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.linkView('alice', VIEW);

    expect(profiles.order('alice')).toEqual(['s1', 's2']);
    await profiles.select('alice', VIEW.sessionId);
    expect(profiles.selection('alice')).toBeNull();
    await profiles.reorder('alice', [VIEW.sessionId], profiles.orderVersion('alice'));
    expect(profiles.order('alice')).toEqual(['s1', 's2']);
  });

  it('drops one view by path and keeps its siblings', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.linkView('alice', VIEW);
    await profiles.linkView('alice', { ...VIEW, path: ['worker', 'scout'], sessionId: 'child-2' });

    expect(await profiles.unlinkView('alice', 's1', ['worker'])).toBe(true);
    expect(await profiles.unlinkView('alice', 's1', ['worker'])).toBe(false);
    expect(profiles.views('alice').map((view) => view.path)).toEqual([['worker', 'scout']]);
  });

  it('removes a root view set for every user, or for one user only', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.linkView('alice', VIEW);
    await profiles.linkView('bob', VIEW);

    expect(await profiles.unlinkViewsUnder('s1', 'alice')).toEqual(['alice']);
    expect(profiles.views('alice')).toEqual([]);
    expect(profiles.views('bob')).toEqual([VIEW]);

    expect(await profiles.unlinkViewsUnder('s1')).toEqual(['bob']);
    expect(profiles.views('bob')).toEqual([]);
  });

  it('drops a root’s views when the root leaves every profile', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.linkView('alice', VIEW);

    expect(await profiles.unlinkAll('s1')).toEqual(['alice']);
    expect(profiles.views('alice')).toEqual([]);
  });

  it('prunes views whose root the boot sweep rejected', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.link('alice', S2);
    await profiles.linkView('alice', VIEW);
    await profiles.linkView('alice', { ...VIEW, rootSessionId: 's2', sessionId: 'child-2' });

    await profiles.gc(new Set(['s2']));

    expect(profiles.get('alice').map((ref) => ref.sessionId)).toEqual(['s2']);
    expect(profiles.views('alice').map((view) => view.rootSessionId)).toEqual(['s2']);
  });

  it('drops every view at boot because a view needs a live borrowed runtime', async () => {
    const profiles = new UserProfiles(storePath());
    await profiles.load();
    await profiles.link('alice', S1);
    await profiles.linkView('alice', VIEW);

    await profiles.dropAllViews();

    expect(profiles.views('alice')).toEqual([]);
    expect(profiles.get('alice').map((ref) => ref.sessionId)).toEqual(['s1']);
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
