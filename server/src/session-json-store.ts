/**
 * Generic per-session JSON persistence seam.
 *
 * Feature adapters (for example static hosting and file downloads) own their
 * document shape while this module owns the process-level storage contract.
 */
import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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
  constructor(private readonly storeDir: string) {}

  private pathFor(sessionId: string): string {
    return join(this.storeDir, `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<TDocument | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    try {
      return JSON.parse(raw) as TDocument;
    } catch {
      return undefined;
    }
  }

  async write(sessionId: string, document: TDocument): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const finalPath = this.pathFor(sessionId);
    const temporaryPath = `${finalPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, finalPath);
  }

  async remove(sessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/**
 * Remove orphaned per-session documents and abandoned temporary writes at
 * boot. Callers must skip this operation when session enumeration failed.
 */
export async function gcSessionJsonStore(args: { storeDir: string; validSessionIds: Set<string> }): Promise<void> {
  let entries;
  try {
    entries = await readdir(args.storeDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;

      const isTemporary = entry.name.endsWith('.json.tmp');
      const isDocument = entry.name.endsWith('.json');
      if (!isTemporary && !isDocument) return;
      if (isDocument && args.validSessionIds.has(entry.name.slice(0, -'.json'.length))) return;

      try {
        await unlink(join(args.storeDir, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }),
  );
}
