import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionSummaryIndex, sessionDirFor } from './session-summaries.js';

let agentDir: string;
let folderPath: string;
let index: SessionSummaryIndex;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pimote-summaries-'));
  folderPath = '/home/user/project-under-test';
  index = new SessionSummaryIndex(agentDir);
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

/** Write a session file into the folder's session directory under the test agent dir. */
async function writeSession(fileName: string, lines: string[]): Promise<string> {
  const dir = sessionDirFor(folderPath, agentDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function sessionLines(overrides: { id?: string; cwd?: string; extra?: string[] } = {}): string[] {
  return [
    `{"type":"session","id":"${overrides.id ?? 's-1'}","timestamp":"2025-06-15T10:00:00.000Z","cwd":"${overrides.cwd ?? folderPath}"}`,
    '{"type":"message","timestamp":"2025-06-15T10:01:00.000Z","message":{"role":"user","content":"Hello world"}}',
    '{"type":"message","timestamp":"2025-06-15T10:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}',
    ...(overrides.extra ?? []),
  ];
}

describe('sessionDirFor', () => {
  it('mirrors pi session-dir encoding: leading separator stripped, separators and colons dashed, wrapped in --', () => {
    expect(sessionDirFor('/home/user/proj', '/agent')).toBe('/agent/sessions/--home-user-proj--');
    expect(sessionDirFor('/home/user/proj/', '/agent')).toBe('/agent/sessions/--home-user-proj--');
    expect(sessionDirFor('/a/b c/d', '/agent')).toBe('/agent/sessions/--a-b c-d--');
    expect(sessionDirFor('/c:/x', '/agent')).toBe('/agent/sessions/--c--x--');
  });
});

describe('SessionSummaryIndex.list()', () => {
  it('derives the list metadata from a session file', async () => {
    await writeSession('s-1.jsonl', sessionLines({ extra: ['{"type":"session_info","name":"  Named session  "}'] }));

    const summaries = await index.list(folderPath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 's-1',
      cwd: folderPath,
      name: 'Named session',
      messageCount: 2,
      firstMessage: 'Hello world',
    });
    expect(summaries[0].created.toISOString()).toBe('2025-06-15T10:00:00.000Z');
    // modified is the most recent message activity, not the header time.
    expect(summaries[0].modified.toISOString()).toBe('2025-06-15T10:02:00.000Z');
    expect(summaries[0].path).toMatch(/s-1\.jsonl$/);
    expect(summaries[0]).not.toHaveProperty('allMessagesText');
  });

  it('matches pi SessionManager.list() on the same file (minus allMessagesText)', async () => {
    const filePath = await writeSession('s-1.jsonl', sessionLines({ extra: ['{"type":"session_info","name":"Parity"}'] }));

    const ours = (await index.list(folderPath))[0];
    const theirs = (await SessionManager.list(folderPath, join(sessionDirFor(folderPath, agentDir)))).find((s) => s.path === filePath);

    expect(theirs).toBeDefined();
    expect(ours.id).toBe(theirs!.id);
    expect(ours.cwd).toBe(theirs!.cwd);
    expect(ours.name).toBe(theirs!.name);
    expect(ours.messageCount).toBe(theirs!.messageCount);
    expect(ours.firstMessage).toBe(theirs!.firstMessage);
    expect(ours.created.getTime()).toBe(theirs!.created.getTime());
    expect(ours.modified.getTime()).toBe(theirs!.modified.getTime());
  });

  it('orders sessions by most recent activity', async () => {
    await writeSession('old.jsonl', sessionLines({ id: 'old' }));
    await writeSession(
      'new.jsonl',
      sessionLines({
        id: 'new',
        extra: ['{"type":"message","timestamp":"2025-06-16T09:00:00.000Z","message":{"role":"user","content":"later"}}'],
      }),
    );

    const summaries = await index.list(folderPath);
    expect(summaries.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('ignores files that are not sessions', async () => {
    await writeSession('s-1.jsonl', sessionLines());
    await writeSession('garbage.jsonl', ['{"not":"a session"}']);
    await writeSession('notes.jsonl', ['just some text']);

    const summaries = await index.list(folderPath);
    expect(summaries.map((s) => s.id)).toEqual(['s-1']);
  });

  it('skips malformed lines without dropping the file', async () => {
    const lines = sessionLines();
    lines.splice(1, 0, 'this is not json');
    await writeSession('s-1.jsonl', lines);

    const summaries = await index.list(folderPath);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].messageCount).toBe(2);
  });

  it('falls back to (no messages) and the header timestamp', async () => {
    await writeSession('empty.jsonl', [`{"type":"session","id":"empty","timestamp":"2025-01-01T00:00:00.000Z","cwd":"${folderPath}"}`]);

    const summaries = await index.list(folderPath);
    expect(summaries[0].firstMessage).toBe('(no messages)');
    expect(summaries[0].messageCount).toBe(0);
    expect(summaries[0].modified.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('falls back to the file mtime when the header timestamp is unusable', async () => {
    const filePath = await writeSession('no-time.jsonl', [`{"type":"session","id":"t","timestamp":"not-a-date","cwd":"${folderPath}"}`]);

    const summaries = await index.list(folderPath);
    const stats = await stat(filePath);
    expect(summaries[0].modified.getTime()).toBe(stats.mtime.getTime());
    // created is always a valid Date — every consumer formats it with
    // toISOString(), which throws on Invalid Date.
    expect(summaries[0].created.getTime()).toBe(stats.mtime.getTime());
  });

  it('falls back to the file mtime when the header carries no timestamp at all', async () => {
    const filePath = await writeSession('no-time.jsonl', [`{"type":"session","id":"t","cwd":"${folderPath}"}`]);

    const summaries = await index.list(folderPath);
    const stats = await stat(filePath);
    expect(summaries[0].created.getTime()).toBe(stats.mtime.getTime());
  });

  it('skips a malformed message entry instead of rejecting the session file', async () => {
    const lines = sessionLines();
    lines.splice(1, 0, '{"type":"message","message":null}', '{"type":"message"}');
    await writeSession('s-1.jsonl', lines);

    const summaries = await index.list(folderPath);
    expect(summaries.map((s) => s.id)).toEqual(['s-1']);
    expect(summaries[0].firstMessage).toBe('Hello world');
  });

  it('surfaces a per-file read failure instead of silently dropping the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeSession('s-ok.jsonl', sessionLines({ id: 'ok' }));
      // A directory with a .jsonl name: it passes the listing filter and its
      // summary read fails, without touching the healthy sibling.
      await mkdir(join(sessionDirFor(folderPath, agentDir), 'bad.jsonl'), { recursive: true });

      await expect(index.list(folderPath, { failOnError: true })).rejects.toThrow(/session file/);
      expect((await index.list(folderPath)).map((s) => s.id)).toEqual(['ok']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never caches a failed summary: the omission is retried until the file is readable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const badPath = join(sessionDirFor(folderPath, agentDir), 'bad.jsonl');
      await mkdir(badPath, { recursive: true });
      expect(await index.list(folderPath)).toEqual([]);

      // The failure is not pinned: replacing the unreadable entry with a
      // session file is seen on the very next listing (same path — the cache
      // key — would hit if the failure had been cached).
      await rm(badPath, { recursive: true, force: true });
      await writeSession('bad.jsonl', sessionLines({ id: 'healed' }));

      expect((await index.list(folderPath)).map((s) => s.id)).toEqual(['healed']);
    } finally {
      warn.mockRestore();
    }
  });

  it('takes the latest session_info name, and an explicit clear drops it', async () => {
    await writeSession('s-1.jsonl', sessionLines({ extra: ['{"type":"session_info","name":"First"}', '{"type":"session_info","name":"Second"}'] }));
    expect((await index.list(folderPath))[0].name).toBe('Second');

    const cleared = new SessionSummaryIndex(agentDir);
    await writeSession('s-2.jsonl', sessionLines({ id: 's-2', extra: ['{"type":"session_info","name":"First"}', '{"type":"session_info"}'] }));
    const summary = (await cleared.list(folderPath)).find((s) => s.id === 's-2');
    expect(summary?.name).toBeUndefined();
  });

  it('returns [] when the session directory does not exist', async () => {
    await expect(index.list('/no/such/folder')).resolves.toEqual([]);
  });
});

describe('SessionSummaryIndex caching', () => {
  it('serves an unchanged listing from cached objects (no reparse)', async () => {
    await writeSession('s-1.jsonl', sessionLines());

    const first = await index.list(folderPath);
    const second = await index.list(folderPath);

    expect(second[0]).toBe(first[0]); // same object identity = cache hit
  });

  it('reparses only the file that changed', async () => {
    const changed = await writeSession('changed.jsonl', sessionLines({ id: 'changed' }));
    await writeSession('untouched.jsonl', sessionLines({ id: 'untouched' }));

    const before = await index.list(folderPath);
    const untouchedBefore = before.find((s) => s.id === 'untouched');

    await appendFile(changed, '{"type":"message","timestamp":"2025-06-17T10:00:00.000Z","message":{"role":"user","content":"appended"}}\n', 'utf8');

    const after = await index.list(folderPath);
    expect(after.find((s) => s.id === 'changed')?.messageCount).toBe(3);
    expect(after.find((s) => s.id === 'untouched')).toBe(untouchedBefore); // untouched served from cache
  });

  it('drops deleted files from the next listing', async () => {
    const filePath = await writeSession('s-1.jsonl', sessionLines());
    await writeSession('s-2.jsonl', sessionLines({ id: 's-2' }));
    expect(await index.list(folderPath)).toHaveLength(2);

    await unlink(filePath);
    expect((await index.list(folderPath)).map((s) => s.id)).toEqual(['s-2']);
  });

  it('shares one listing between concurrent callers', async () => {
    await writeSession('s-1.jsonl', sessionLines());
    const [a, b] = await Promise.all([index.list(folderPath), index.list(folderPath)]);
    expect(a[0]).toBe(b[0]);
  });
});
