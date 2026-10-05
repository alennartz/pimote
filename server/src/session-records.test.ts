import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRecords } from './session-records.js';
import { SessionSummaryIndex, sessionDirFor } from './session-summaries.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** One session file in the folder's session directory. */
async function writeSession(folderDir: string, agentDir: string, file: string, lines: string[]): Promise<string> {
  const sessionDir = sessionDirFor(folderDir, agentDir);
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, file);
  await writeFile(sessionPath, lines.join('\n') + '\n', 'utf8');
  return sessionPath;
}

function sessionRecordsFor(agentDir: string): SessionRecords {
  return new SessionRecords(new SessionSummaryIndex(agentDir));
}

describe('SessionRecords.listSessions()', () => {
  it('returns empty array when the session directory does not exist', async () => {
    const records = sessionRecordsFor(join(tempDir, 'agent'));
    const sessions = await records.listSessions(join(tempDir, 'nonexistent'));

    expect(sessions).toEqual([]);
  });

  it('maps session records dates to ISO strings', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    await writeSession(folderDir, agentDir, 's-1.jsonl', [
      `{"type":"session","id":"abc-123","timestamp":"2025-06-15T10:30:00.000Z","cwd":"${folderDir}"}`,
      `{"type":"message","timestamp":"2025-06-15T10:31:00.000Z","message":{"role":"user","content":"Hello world"}}`,
      `{"type":"session_info","name":"Test Session"}`,
    ]);

    const records = sessionRecordsFor(agentDir);
    const sessions = await records.listSessions(folderDir);

    expect(sessions).toEqual([
      {
        id: 'abc-123',
        name: 'Test Session',
        created: '2025-06-15T10:30:00.000Z',
        modified: '2025-06-15T10:31:00.000Z',
        messageCount: 1,
        firstMessage: 'Hello world',
      },
    ]);
  });

  it('maps sessions without optional name', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    await writeSession(folderDir, agentDir, 's-2.jsonl', [
      `{"type":"session","id":"def-456","timestamp":"2025-01-01T00:00:00.000Z","cwd":"${folderDir}"}`,
      `{"type":"message","timestamp":"2025-01-01T00:01:00.000Z","message":{"role":"user","content":"hi"}}`,
    ]);

    const records = sessionRecordsFor(agentDir);
    const sessions = await records.listSessions(folderDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeUndefined();
    expect(sessions[0].firstMessage).toBe('hi');
  });
});

describe('SessionRecords.listSessionRecords()', () => {
  it('returns raw session summaries served by the summary cache', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    const sessionPath = await writeSession(folderDir, agentDir, 's-1.jsonl', [
      `{"type":"session","id":"abc-123","timestamp":"2025-06-15T10:30:00.000Z","cwd":"${folderDir}"}`,
      `{"type":"message","timestamp":"2025-06-15T10:31:00.000Z","message":{"role":"user","content":"Hello world"}}`,
    ]);

    const summaries = new SessionSummaryIndex(agentDir);
    const listSpy = vi.spyOn(summaries, 'list');
    const records = new SessionRecords(summaries);

    const result = await records.listSessionRecords(folderDir);

    expect(listSpy).toHaveBeenCalledWith(folderDir);
    expect(result).toEqual([
      {
        path: sessionPath,
        id: 'abc-123',
        cwd: folderDir,
        name: undefined,
        parentSessionPath: undefined,
        created: new Date('2025-06-15T10:30:00.000Z'),
        modified: new Date('2025-06-15T10:31:00.000Z'),
        messageCount: 1,
        firstMessage: 'Hello world',
      },
    ]);
  });

  it('degrades to an empty result with a warning when enumeration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const agentDir = join(tempDir, 'agent');
      const folderDir = join(tempDir, 'project');
      // A file where the session directory should be: readdir fails with
      // something other than ENOENT, so enumeration cannot prove its result.
      const sessionDir = sessionDirFor(folderDir, agentDir);
      await mkdir(sessionDir, { recursive: true });
      await rm(sessionDir, { recursive: true, force: true });
      await writeFile(sessionDir, 'not a directory', 'utf8');

      const records = sessionRecordsFor(agentDir);
      await expect(records.listSessionRecords(folderDir)).resolves.toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('throws on enumeration failure in strict mode', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    const sessionDir = sessionDirFor(folderDir, agentDir);
    await mkdir(sessionDir, { recursive: true });
    await rm(sessionDir, { recursive: true, force: true });
    await writeFile(sessionDir, 'not a directory', 'utf8');

    const records = sessionRecordsFor(agentDir);
    await expect(records.listSessionRecords(folderDir, { failOnError: true })).rejects.toThrow();
  });
});

describe('SessionRecords.resolveSessionPath()', () => {
  it('resolves a session id to its file path', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    const sessionPath = await writeSession(folderDir, agentDir, 's-1.jsonl', [`{"type":"session","id":"abc-123","timestamp":"2025-06-15T10:30:00.000Z","cwd":"${folderDir}"}`]);

    const records = sessionRecordsFor(agentDir);
    await expect(records.resolveSessionPath(folderDir, 'abc-123')).resolves.toBe(sessionPath);
  });

  it('returns undefined for a missing session', async () => {
    const records = sessionRecordsFor(join(tempDir, 'agent'));
    await expect(records.resolveSessionPath(join(tempDir, 'nonexistent'), 'ghost')).resolves.toBeUndefined();
  });
});

describe('SessionRecords.renameSession()', () => {
  it('appends session info when the session file exists', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const openSpy = vi.spyOn(SessionManager, 'open').mockReturnValue({
      appendSessionInfo: vi.fn(),
    } as any);

    const records = sessionRecordsFor(join(tempDir, 'agent'));
    const resolveSpy = vi.spyOn(records, 'resolveSessionPath').mockResolvedValue('/tmp/session-1.jsonl');

    const renamed = await records.renameSession('/home/user/project', 'session-1', 'Renamed Session');

    expect(renamed).toBe(true);
    expect(resolveSpy).toHaveBeenCalledWith('/home/user/project', 'session-1');
    expect(openSpy).toHaveBeenCalledWith('/tmp/session-1.jsonl');
    expect(openSpy.mock.results[0]?.value.appendSessionInfo).toHaveBeenCalledWith('Renamed Session');

    openSpy.mockRestore();
  });

  it('returns false when the session file cannot be found', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const openSpy = vi.spyOn(SessionManager, 'open');
    const records = sessionRecordsFor(join(tempDir, 'agent'));
    vi.spyOn(records, 'resolveSessionPath').mockResolvedValue(undefined);

    const renamed = await records.renameSession('/home/user/project', 'missing', 'Renamed Session');

    expect(renamed).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});

describe('SessionRecords.deleteSession()', () => {
  it('deletes the session file when found', async () => {
    const agentDir = join(tempDir, 'agent');
    const folderDir = join(tempDir, 'project');
    await writeSession(folderDir, agentDir, 's-1.jsonl', [`{"type":"session","id":"abc-123","timestamp":"2025-06-15T10:30:00.000Z","cwd":"${folderDir}"}`]);

    const records = sessionRecordsFor(agentDir);
    await expect(records.deleteSession(folderDir, 'abc-123')).resolves.toBe(true);
    await expect(records.resolveSessionPath(folderDir, 'abc-123')).resolves.toBeUndefined();
  });

  it('returns false when the session cannot be found', async () => {
    const records = sessionRecordsFor(join(tempDir, 'agent'));
    await expect(records.deleteSession(join(tempDir, 'nonexistent'), 'ghost')).resolves.toBe(false);
  });
});
