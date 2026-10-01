import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

export interface ValidateDownloadSourceInput {
  /** Lexical source path captured in the download registration. */
  sourcePath: string;
  /** Root that relative source paths resolve against. */
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

/** Resolve a registered source path lexically; relative paths join the root. */
function resolveSourcePath(input: ValidateDownloadSourceInput): string {
  if (typeof input.sourcePath !== 'string' || typeof input.workspaceRoot !== 'string' || input.workspaceRoot.length === 0) {
    throw new Error('download source and workspace root must be paths');
  }
  const root = resolve(input.workspaceRoot);
  return isAbsolute(input.sourcePath) ? resolve(input.sourcePath) : resolve(root, input.sourcePath);
}

export async function validateDownloadSource(input: ValidateDownloadSourceInput): Promise<ValidatedDownloadSource> {
  const lexicalSource = resolveSourcePath(input);
  const resolvedPath = await realpath(lexicalSource);

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
 * `realpath`/`stat` and before `createReadStream`, so the reported size and
 * regular-file facts could describe a different object than the one streamed.
 * Opening first and validating the descriptor closes that gap; the stream must
 * use this handle rather than reopening the pathname.
 */
export async function openDownloadSource(input: ValidateDownloadSourceInput): Promise<OpenedDownloadSource> {
  const lexicalSource = resolveSourcePath(input);
  const handle = await open(lexicalSource, 'r');

  try {
    // Linux exposes the kernel-resolved target for an open descriptor here.
    // This is the object that will actually be streamed, even if its pathname
    // is replaced after open().
    const resolvedPath = await realpath(`/proc/self/fd/${handle.fd}`);

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
