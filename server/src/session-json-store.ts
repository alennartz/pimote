/**
 * Generic per-session JSON persistence seam.
 *
 * Feature adapters (for example static hosting and file downloads) own their
 * document shape while this module owns the process-level storage contract.
 */
export interface SessionJsonStore<TDocument> {
  /** Read a session document, or `undefined` when no document exists. */
  read(sessionId: string): Promise<TDocument | undefined>;

  /** Atomically replace a session document. */
  write(sessionId: string, document: TDocument): Promise<void>;

  /** Remove a session document; absence is not an error. */
  remove(sessionId: string): Promise<void>;
}

/** Filesystem-backed implementation of the common session JSON seam. */
export class FileSessionJsonStore<TDocument> implements SessionJsonStore<TDocument> {
  constructor(_storeDir: string) {
    throw new Error('not implemented');
  }

  read(_sessionId: string): Promise<TDocument | undefined> {
    throw new Error('not implemented');
  }

  write(_sessionId: string, _document: TDocument): Promise<void> {
    throw new Error('not implemented');
  }

  remove(_sessionId: string): Promise<void> {
    throw new Error('not implemented');
  }
}

/**
 * Remove orphaned per-session documents and abandoned temporary writes at
 * boot. Callers must skip this operation when session enumeration failed.
 */
export function gcSessionJsonStore(_args: { storeDir: string; validSessionIds: Set<string> }): Promise<void> {
  throw new Error('not implemented');
}
