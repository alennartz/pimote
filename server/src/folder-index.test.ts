import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderIndex } from './folder-index.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
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
      activeSessionCount: 0,
      externalProcessCount: 0,
      activeStatus: null,
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

  it('detects directories with .pi/sessions marker', async () => {
    const projectDir = join(tempDir, 'pi-project');
    await mkdir(join(projectDir, '.pi', 'sessions'), { recursive: true });

    const index = new FolderIndex([tempDir]);
    const folders = await index.scan();

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('pi-project');
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
  it('returns empty array when SessionManager.list() fails', async () => {
    // Use a non-existent path which should cause SessionManager.list() to fail or return empty
    const index = new FolderIndex([]);
    const sessions = await index.listSessions(join(tempDir, 'nonexistent'));

    expect(sessions).toEqual([]);
  });

  it('maps pi SessionInfo dates to ISO strings', async () => {
    // We can test the mapping logic by mocking SessionManager.list()
    const { SessionManager } = await import('@mariozechner/pi-coding-agent');

    const mockDate1 = new Date('2025-06-15T10:30:00Z');
    const mockDate2 = new Date('2025-06-15T11:45:00Z');

    const listSpy = vi.spyOn(SessionManager, 'list').mockResolvedValueOnce([
      {
        path: '/tmp/session-1.jsonl',
        id: 'abc-123',
        cwd: '/home/user/project',
        name: 'Test Session',
        parentSessionPath: undefined,
        created: mockDate1,
        modified: mockDate2,
        messageCount: 5,
        firstMessage: 'Hello world',
        allMessagesText: 'Hello world ...',
      },
    ]);

    const index = new FolderIndex([]);
    const sessions = await index.listSessions('/home/user/project');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      id: 'abc-123',
      name: 'Test Session',
      created: '2025-06-15T10:30:00.000Z',
      modified: '2025-06-15T11:45:00.000Z',
      messageCount: 5,
      firstMessage: 'Hello world',
    });

    listSpy.mockRestore();
  });

  it('maps sessions without optional name', async () => {
    const { SessionManager } = await import('@mariozechner/pi-coding-agent');

    const listSpy = vi.spyOn(SessionManager, 'list').mockResolvedValueOnce([
      {
        path: '/tmp/session-2.jsonl',
        id: 'def-456',
        cwd: '/home/user/project',
        name: undefined,
        parentSessionPath: undefined,
        created: new Date('2025-01-01T00:00:00Z'),
        modified: new Date('2025-01-02T00:00:00Z'),
        messageCount: 0,
        firstMessage: '',
        allMessagesText: '',
      },
    ]);

    const index = new FolderIndex([]);
    const sessions = await index.listSessions('/home/user/project');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBeUndefined();
    expect(sessions[0].firstMessage).toBeUndefined();

    listSpy.mockRestore();
  });
});
