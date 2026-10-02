import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderIndex } from './folder-index.js';
import { SessionSummaryIndex, sessionDirFor } from './session-summaries.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FolderIndex.roots', () => {
  it('returns the configured roots', () => {
    const index = new FolderIndex(['/home/user/projects', '/opt/repos']);
    expect(index.roots).toEqual(['/home/user/projects', '/opt/repos']);
  });

  it('returns empty array when no roots configured', () => {
    const index = new FolderIndex([]);
    expect(index.roots).toEqual([]);
  });
});

describe('FolderIndex.scan()', () => {
  it('detects directories with .git marker', async () => {
    const projectDir = join(tempDir, 'my-project');
    await mkdir(join(projectDir, '.git'), { recursive: true });

    const index = new FolderIndex([tempDir]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0]).toEqual({
      path: projectDir,
      name: 'my-project',
      kind: 'single',
      activeSessionCount: 0,
      externalProcessCount: 0,
    });
  });

  it('detects directories with package.json marker', async () => {
    const projectDir = join(tempDir, 'npm-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'package.json'), '{}');

    const index = new FolderIndex([tempDir]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('npm-project');
  });

  it('excludes directories without project markers', async () => {
    // Project dir with marker
    const projectDir = join(tempDir, 'real-project');
    await mkdir(join(projectDir, '.git'), { recursive: true });

    // Non-project dir with no markers
    const plainDir = join(tempDir, 'just-a-folder');
    await mkdir(plainDir, { recursive: true });

    const index = new FolderIndex([tempDir]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('real-project');
  });

  it('skips files in root (only looks at directories)', async () => {
    await writeFile(join(tempDir, 'some-file.txt'), 'hello');

    const projectDir = join(tempDir, 'a-project');
    await mkdir(join(projectDir, '.git'), { recursive: true });

    const index = new FolderIndex([tempDir]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('a-project');
  });

  it('scans multiple roots', async () => {
    const root1 = join(tempDir, 'root1');
    const root2 = join(tempDir, 'root2');

    const proj1 = join(root1, 'proj-a');
    const proj2 = join(root2, 'proj-b');
    await mkdir(join(proj1, '.git'), { recursive: true });
    await mkdir(join(proj2, '.git'), { recursive: true });

    const index = new FolderIndex([root1, root2]);
    const folders = await index.scan();

    expect(folders).toHaveLength(2);
    const names = folders.map((f) => f.name).sort();
    expect(names).toEqual(['proj-a', 'proj-b']);
  });

  it('gracefully handles missing root directories', async () => {
    const missingRoot = join(tempDir, 'does-not-exist');

    const index = new FolderIndex([missingRoot]);
    const folders = await index.scan();

    expect(folders).toEqual([]);
  });

  it('gracefully handles a mix of valid and missing roots', async () => {
    const validRoot = join(tempDir, 'valid-root');
    const projectDir = join(validRoot, 'project');
    await mkdir(join(projectDir, '.git'), { recursive: true });

    const missingRoot = join(tempDir, 'missing-root');

    const index = new FolderIndex([missingRoot, validRoot]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('project');
  });
});

describe('FolderIndex.listSessions()', () => {
  it('returns empty array when the session directory does not exist', async () => {
    const index = new FolderIndex([]);
    const sessions = await index.listSessions(join(tempDir, 'nonexistent'));

    expect(sessions).toEqual([]);
  });

  it('maps session records dates to ISO strings', async () => {
    const agentDir = join(tempDir, 'agent');
    const projectDir = join(tempDir, 'project');
    const sessionDir = sessionDirFor(projectDir, agentDir);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 's-1.jsonl'),
      [
        `{"type":"session","id":"abc-123","timestamp":"2025-06-15T10:30:00.000Z","cwd":"${projectDir}"}`,
        `{"type":"message","timestamp":"2025-06-15T10:31:00.000Z","message":{"role":"user","content":"Hello world"}}`,
        `{"type":"session_info","name":"Test Session"}`,
      ].join('\n') + '\n',
      'utf8',
    );

    const index = new FolderIndex([], new SessionSummaryIndex(agentDir));
    const sessions = await index.listSessions(projectDir);

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
    const projectDir = join(tempDir, 'project');
    const sessionDir = sessionDirFor(projectDir, agentDir);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 's-2.jsonl'),
      [
        `{"type":"session","id":"def-456","timestamp":"2025-01-01T00:00:00.000Z","cwd":"${projectDir}"}`,
        `{"type":"message","timestamp":"2025-01-01T00:01:00.000Z","message":{"role":"user","content":"hi"}}`,
      ].join('\n') + '\n',
      'utf8',
    );

    const index = new FolderIndex([], new SessionSummaryIndex(agentDir));
    const sessions = await index.listSessions(projectDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeUndefined();
    expect(sessions[0].firstMessage).toBe('hi');
  });
});

describe('FolderIndex.renameSession()', () => {
  it('appends session info when the session file exists', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const openSpy = vi.spyOn(SessionManager, 'open').mockReturnValue({
      appendSessionInfo: vi.fn(),
    } as any);

    const index = new FolderIndex([]);
    const resolveSpy = vi.spyOn(index, 'resolveSessionPath').mockResolvedValue('/tmp/session-1.jsonl');

    const renamed = await index.renameSession('/home/user/project', 'session-1', 'Renamed Session');

    expect(renamed).toBe(true);
    expect(resolveSpy).toHaveBeenCalledWith('/home/user/project', 'session-1');
    expect(openSpy).toHaveBeenCalledWith('/tmp/session-1.jsonl');
    expect(openSpy.mock.results[0]?.value.appendSessionInfo).toHaveBeenCalledWith('Renamed Session');

    openSpy.mockRestore();
  });

  it('returns false when the session file cannot be found', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const openSpy = vi.spyOn(SessionManager, 'open');
    const index = new FolderIndex([]);
    vi.spyOn(index, 'resolveSessionPath').mockResolvedValue(undefined);

    const renamed = await index.renameSession('/home/user/project', 'missing', 'Renamed Session');

    expect(renamed).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});
