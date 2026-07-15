import { realpath, stat } from 'node:fs/promises';
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
export async function validateDownloadSource(input: ValidateDownloadSourceInput): Promise<ValidatedDownloadSource> {
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
