import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FileGetResponseData, FilePutResponseData } from '../../shared/dist/index.js';

/**
 * Pure. Expands leading `~`/`~/` against homeDir; resolves otherwise. Throws on empty path.
 */
export function resolveFilePath(path: string, homeDir: string): string {
  if (path === '') throw new Error('path is required');
  if (path === '~') return resolve(homeDir);
  if (path.startsWith('~/')) return resolve(homeDir, path.slice(2));
  return resolve(path);
}

/** Pure. Decodes bytes as strict UTF-8; throws on invalid sequences. */
function decodeUtf8Strict(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`File is not valid UTF-8: ${path}`, { cause });
  }
}

/** Pure. True when the fs error means "no such file or directory". */
function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Resolves, reads UTF-8. Missing file → { path, exists: false, content: '' }.
 * Throws on a directory, an unreadable file, or a non-UTF-8 read failure.
 */
export async function readEditableFile(path: string): Promise<FileGetResponseData> {
  const resolved = resolveFilePath(path, homedir());
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (err) {
    if (isMissingFileError(err)) return { path: resolved, exists: false, content: '' };
    throw err;
  }
  return { path: resolved, exists: true, content: decodeUtf8Strict(bytes, resolved) };
}

/**
 * Resolves, mkdir -p parent, atomic write (temp + rename). Returns { path }.
 * Creates the file when missing; last-write-wins.
 */
export async function writeEditableFile(path: string, content: string): Promise<FilePutResponseData> {
  const resolved = resolveFilePath(path, homedir());
  const dir = dirname(resolved);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(resolved)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, resolved);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return { path: resolved };
}
