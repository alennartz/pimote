import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ValidateDownloadSourceInput {
  /** Lexical source path captured in the download registration. */
  sourcePath: string;
  /** Workspace root captured with that registration. */
  workspaceRoot: string;
}

/** The current regular-file facts safe for the manager or route to use. */
export interface ValidatedDownloadSource {
  /** Canonical real path of the current source file. */
  resolvedPath: string;
  /** Basename derived from the canonical regular-file path. */
  filename: string;
  /** File size at validation time. */
  sizeBytes: number;
}

/** A validated descriptor whose target cannot change underneath the caller. */
export interface OpenedDownloadSource extends ValidatedDownloadSource {
  handle: FileHandle;
}

function isContainedBy(rootPath: string, candidatePath: string): boolean {
  const fromRoot = relative(rootPath, candidatePath);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

/**
 * Resolve a registered source path and prove that it remains a regular file
 * inside its captured workspace. The lexical check rejects `..` and absolute
 * escapes before filesystem access; the real-path check rejects symlink
 * escapes after following in-workspace links.
 */
interface ResolvedDownloadPaths {
  lexicalSource: string;
  realRoot: string;
}

async function resolveDownloadPaths(input: ValidateDownloadSourceInput): Promise<ResolvedDownloadPaths> {
  if (typeof input.sourcePath !== 'string' || typeof input.workspaceRoot !== 'string' || input.workspaceRoot.length === 0) {
    throw new Error('download source and workspace root must be paths');
  }

  const lexicalRoot = resolve(input.workspaceRoot);
  const lexicalSource = isAbsolute(input.sourcePath) ? resolve(input.sourcePath) : resolve(lexicalRoot, input.sourcePath);
  if (!isContainedBy(lexicalRoot, lexicalSource)) {
    throw new Error('download source escapes its workspace');
  }

  const realRoot = await realpath(lexicalRoot);
  const rootStat = await stat(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error('download workspace is not a directory');
  }

  return { lexicalSource, realRoot };
}

export async function validateDownloadSource(input: ValidateDownloadSourceInput): Promise<ValidatedDownloadSource> {
  const { lexicalSource, realRoot } = await resolveDownloadPaths(input);
  const resolvedPath = await realpath(lexicalSource);
  if (!isContainedBy(realRoot, resolvedPath)) {
    throw new Error('download source resolves outside its workspace');
  }

  const sourceStat = await stat(resolvedPath);
  if (!sourceStat.isFile()) {
    throw new Error('download source is not a regular file');
  }

  return {
    resolvedPath,
    filename: basename(resolvedPath),
    sizeBytes: sourceStat.size,
  };
}

/**
 * Open and validate the current source in one operation. Validation based on a
 * pathname alone has a TOCTOU gap: the pathname can be replaced after
 * `realpath`/`stat` and before `createReadStream`. Opening first and validating
 * the descriptor's `/proc/self/fd` target closes that gap; the stream must use
 * this handle rather than reopening the pathname.
 */
export async function openDownloadSource(input: ValidateDownloadSourceInput): Promise<OpenedDownloadSource> {
  const { lexicalSource, realRoot } = await resolveDownloadPaths(input);
  const handle = await open(lexicalSource, 'r');

  try {
    // Linux exposes the kernel-resolved target for an open descriptor here.
    // This is the object that will actually be streamed, even if its pathname
    // is replaced after open().
    const resolvedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isContainedBy(realRoot, resolvedPath)) {
      throw new Error('download source resolves outside its workspace');
    }

    const sourceStat = await handle.stat();
    if (!sourceStat.isFile()) {
      throw new Error('download source is not a regular file');
    }

    return {
      handle,
      resolvedPath,
      filename: basename(resolvedPath.replace(/ \(deleted\)$/, '')),
      sizeBytes: sourceStat.size,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
