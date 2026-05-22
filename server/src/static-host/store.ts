import type { CardColor } from '../../../shared/dist/index.js';

/** One persisted entry; the in-memory `StaticHostRegistration.sessionId` is implicit from the filename. */
export interface StaticHostStoreEntry {
  slug: string;
  folderPath: string;
  cardMetadata: { title: string; tag?: string; color?: CardColor };
}

/** The on-disk shape of `<storeDir>/<sessionId>.json`. */
export interface StaticHostStoreFile {
  version: 1;
  entries: StaticHostStoreEntry[];
}

/**
 * Per-session JSON persistence for the static-host extension.
 *
 * Files live at `${storeDir}/${sessionId}.json`. Writes are atomic
 * (write-to-tmp + rename) so a crash mid-write never leaves a half-written file.
 */
export interface StaticHostStore {
  /** Read state for a session, or `undefined` if no file exists. */
  read(sessionId: string): Promise<StaticHostStoreFile | undefined>;

  /** Atomically write state. Creates the directory tree if missing. */
  write(sessionId: string, file: StaticHostStoreFile): Promise<void>;

  /** Delete the file for a session. No-op if absent. */
  remove(sessionId: string): Promise<void>;
}

/**
 * Filesystem-backed `StaticHostStore`. One file per sessionId under `storeDir`.
 */
export class FileStaticHostStore implements StaticHostStore {
  constructor(private readonly storeDir: string) {}

  async read(_sessionId: string): Promise<StaticHostStoreFile | undefined> {
    throw new Error('not implemented');
  }

  async write(_sessionId: string, _file: StaticHostStoreFile): Promise<void> {
    throw new Error('not implemented');
  }

  async remove(_sessionId: string): Promise<void> {
    throw new Error('not implemented');
  }
}
