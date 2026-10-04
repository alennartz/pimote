import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, symlink, lstat, stat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveFilePath, readEditableFile, writeEditableFile } from './file-edit.js';

describe('resolveFilePath', () => {
  it('expands a bare ~ to homeDir', () => {
    expect(resolveFilePath('~', '/home/tester')).toBe(resolve('/home/tester'));
  });

  it('expands a leading ~/ against homeDir', () => {
    expect(resolveFilePath('~/.pi/agent/AGENTS.md', '/home/tester')).toBe(resolve('/home/tester/.pi/agent/AGENTS.md'));
  });

  it('expands a bare ~/ to homeDir', () => {
    expect(resolveFilePath('~/', '/home/tester')).toBe(resolve('/home/tester'));
  });

  it('does not expand ~user or other non-~//leading tildes', () => {
    expect(resolveFilePath('~other/x', '/home/tester')).toBe(resolve('~other/x'));
  });

  it('resolves absolute paths through normalization', () => {
    expect(resolveFilePath('/a/b/../c', '/home/tester')).toBe(resolve('/a/c'));
  });

  it('resolves relative paths against the cwd', () => {
    expect(resolveFilePath('some/relative.txt', '/home/tester')).toBe(resolve('some/relative.txt'));
  });

  it('throws on an empty path', () => {
    expect(() => resolveFilePath('', '/home/tester')).toThrow();
  });
});

describe('readEditableFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-edit-read-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads an existing file as UTF-8', async () => {
    const filePath = join(tempDir, 'doc.md');
    await writeFile(filePath, '# hello\n', 'utf-8');
    const result = await readEditableFile(filePath);
    expect(result).toEqual({ path: resolve(filePath), exists: true, content: '# hello\n' });
  });

  it('reports a missing file as exists: false with empty content', async () => {
    const filePath = join(tempDir, 'missing.md');
    const result = await readEditableFile(filePath);
    expect(result).toEqual({ path: resolve(filePath), exists: false, content: '' });
  });

  it('reports a missing file inside a missing directory as exists: false', async () => {
    const filePath = join(tempDir, 'nope', 'deeper', 'missing.md');
    const result = await readEditableFile(filePath);
    expect(result).toEqual({ path: resolve(filePath), exists: false, content: '' });
  });

  it('rejects on a directory', async () => {
    const dirPath = join(tempDir, 'a-dir');
    await mkdir(dirPath);
    await expect(readEditableFile(dirPath)).rejects.toThrow();
  });

  it('rejects on non-UTF-8 content', async () => {
    const filePath = join(tempDir, 'binary.md');
    await writeFile(filePath, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readEditableFile(filePath)).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('rejects on an unreadable file', async () => {
    const filePath = join(tempDir, 'locked.md');
    await writeFile(filePath, 'secret', 'utf-8');
    const { chmod } = await import('node:fs/promises');
    await chmod(filePath, 0o000);
    await expect(readEditableFile(filePath)).rejects.toThrow();
  });

  it('resolves ~ against the real home directory', async () => {
    const result = await readEditableFile('~/definitely-missing-pimote-test-file');
    expect(result).toEqual({ path: join(homedir(), 'definitely-missing-pimote-test-file'), exists: false, content: '' });
  });
});

describe('writeEditableFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-edit-write-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates missing parent directories and writes the file', async () => {
    const filePath = join(tempDir, 'a', 'b', 'AGENTS.md');
    const result = await writeEditableFile(filePath, '# instructions');
    expect(result).toEqual({ path: resolve(filePath) });
    expect(await readFile(filePath, 'utf-8')).toBe('# instructions');
  });

  it('overwrites an existing file (last-write-wins)', async () => {
    const filePath = join(tempDir, 'doc.md');
    await writeFile(filePath, 'old', 'utf-8');
    await writeEditableFile(filePath, 'new');
    expect(await readFile(filePath, 'utf-8')).toBe('new');
  });

  it('creates an empty file when content is empty', async () => {
    const filePath = join(tempDir, 'empty.md');
    await writeEditableFile(filePath, '');
    expect(await readFile(filePath, 'utf-8')).toBe('');
  });

  it('leaves no temp files behind', async () => {
    const filePath = join(tempDir, 'doc.md');
    await writeEditableFile(filePath, 'content');
    expect(await readdir(tempDir)).toEqual(['doc.md']);
  });

  it('writes through a symlink, keeping the link and updating the real target', async () => {
    await mkdir(join(tempDir, 'dotfiles'));
    const realPath = join(tempDir, 'dotfiles', 'AGENTS.md');
    await writeFile(realPath, 'old', 'utf-8');
    const linkPath = join(tempDir, 'AGENTS.md');
    await symlink(realPath, linkPath);

    await writeEditableFile(linkPath, 'new');

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realPath, 'utf-8')).toBe('new');
  });

  it('writes through a dangling symlink instead of replacing it', async () => {
    await mkdir(join(tempDir, 'dotfiles'));
    const realPath = join(tempDir, 'dotfiles', 'AGENTS.md');
    const linkPath = join(tempDir, 'AGENTS.md');
    await symlink(realPath, linkPath);

    await writeEditableFile(linkPath, 'new');

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realPath, 'utf-8')).toBe('new');
  });

  it('writes through a dangling symlink with a relative target in a chain', async () => {
    await mkdir(join(tempDir, 'dotfiles'));
    await mkdir(join(tempDir, 'links'));
    // Both links are relative and dangle: the real target is never created first.
    await symlink(join('..', 'dotfiles', 'AGENTS.md'), join(tempDir, 'links', 'mid'));
    const linkPath = join(tempDir, 'AGENTS.md');
    await symlink(join('links', 'mid'), linkPath);

    await writeEditableFile(linkPath, 'new');

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(tempDir, 'links', 'mid'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(tempDir, 'dotfiles', 'AGENTS.md'), 'utf-8')).toBe('new');
  });

  it('preserves the existing file mode', async () => {
    const filePath = join(tempDir, 'config.json');
    await writeFile(filePath, '{}', 'utf-8');
    await chmod(filePath, 0o600);

    await writeEditableFile(filePath, '{"a":1}');

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, 'utf-8')).toBe('{"a":1}');
  });

  it('leaves no temp files behind when the write fails', async () => {
    const dirPath = join(tempDir, 'a-dir');
    await mkdir(dirPath);
    await expect(writeEditableFile(dirPath, 'content')).rejects.toThrow();
    expect(await readdir(tempDir)).toEqual(['a-dir']);
    expect(await readdir(dirPath)).toEqual([]);
  });
});
