import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FileGetResponseData, FilePutResponseData } from '../../shared/dist/index.js';

/**
 * Expands leading `~`/`~/` against homeDir; resolves everything else via
 * `path.resolve` (relative paths resolve against the process working
 * directory). Throws on empty path.
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

/** Symlink hops followed before giving up (mirrors the kernel's ELOOP budget). */
const MAX_SYMLINK_HOPS = 40;

/**
 * The real file a write lands on: the symlink chain is resolved so a symlinked
 * file (e.g. `AGENTS.md` → dotfiles repo) stays a link and the edit reaches the
 * target. Dangling links are followed too; a genuinely missing file resolves
 * against its directory.
 */
async function realPathForWrite(resolved: string): Promise<string> {
  let current = resolved;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    try {
      return await realpath(current);
    } catch (err) {
      if (!isMissingFileError(err)) throw err;
      let link: string;
      try {
        link = await readlink(current);
      } catch {
        // Not a dangling symlink — a missing file. The kernel resolves any
        // symlinked parents on access, so only the final component matters.
        return resolve(current);
      }
      current = resolve(dirname(current), link);
    }
  }
  throw new Error(`Too many levels of symbolic links: ${resolved}`);
}

/** The permission bits of an existing regular file at `target`, if any. */
async function existingFileMode(target: string): Promise<number | undefined> {
  try {
    const info = await stat(target);
    return info.isFile() ? info.mode & 0o7777 : undefined;
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw err;
  }
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
 * Resolves, mkdir -p parent, atomic write (temp + rename) onto the real target.
 * Symlinks are followed so the link (and its target) survive, and an existing
 * file's permission bits are carried over to the new content. Returns { path }.
 * Creates the file when missing; last-write-wins.
 */
export async function writeEditableFile(path: string, content: string): Promise<FilePutResponseData> {
  const resolved = resolveFilePath(path, homedir());
  await mkdir(dirname(resolved), { recursive: true });
  const target = await realPathForWrite(resolved);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const mode = await existingFileMode(target);
  const tempPath = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf-8');
    if (mode !== undefined) await chmod(tempPath, mode);
    await rename(tempPath, target);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return { path: resolved };
}
