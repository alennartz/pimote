import type { CardColor } from '../../../shared/dist/index.js';
import { FileSessionJsonStore, type SessionJsonStore } from '../session-json-store.js';

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
 * Static hosting owns the persisted document shape while the common session
 * store owns filesystem mechanics such as atomic replacement and corrupt-file
 * handling.
 */
export type StaticHostStore = SessionJsonStore<StaticHostStoreFile>;

/** Filesystem-backed adapter for the static-host persistence contract. */
export class FileStaticHostStore implements StaticHostStore {
  private readonly delegate: SessionJsonStore<StaticHostStoreFile>;

  constructor(storeDir: string) {
    this.delegate = new FileSessionJsonStore<StaticHostStoreFile>(storeDir);
  }

  read(sessionId: string): Promise<StaticHostStoreFile | undefined> {
    return this.delegate.read(sessionId);
  }

  write(sessionId: string, file: StaticHostStoreFile): Promise<void> {
    return this.delegate.write(sessionId, file);
  }

  remove(sessionId: string): Promise<void> {
    return this.delegate.remove(sessionId);
  }
}
