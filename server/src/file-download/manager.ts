import { randomUUID } from 'node:crypto';
import type { DownloadItem, DownloadUpdateEvent } from '../../../shared/dist/index.js';
import type { SessionJsonStore } from '../session-json-store.js';
import { validateDownloadSource } from './source.js';

export type { DownloadItem, DownloadOfferedUpdateEvent, DownloadSnapshotUpdateEvent, DownloadUpdateCause, DownloadUpdateEvent } from '../../../shared/dist/index.js';

/** Persisted server-only registration data. Never sent over the wire. */
export interface DownloadStoreEntry {
  id: string;
  sourcePath: string;
  workspaceRoot: string;
  filename: string;
  sizeBytes: number;
}

/** On-disk document for one owning session. */
export interface DownloadStoreDocument {
  version: 1;
  downloads: DownloadStoreEntry[];
}

export interface OfferDownloadInput {
  sessionId: string;
  workspaceRoot: string;
  path: string;
}

/** Server-only result of atomically consuming one registration. */
export interface DownloadClaim {
  sessionId: string;
  sourcePath: string;
  workspaceRoot: string;
  filename: string;
}

export interface DownloadManager {
  activate(sessionId: string, publish: (update: DownloadUpdateEvent) => void): Promise<void>;
  deactivate(sessionId: string): void;
  offer(input: OfferDownloadInput): Promise<DownloadItem>;
  cancel(sessionId: string, id: string): Promise<{ cancelled: boolean }>;
  /** Rejects when durable single-use removal cannot complete; callers must serve no bytes. */
  claim(id: string): Promise<DownloadClaim | undefined>;
  snapshot(sessionId: string): DownloadItem[];
}

export interface CreateDownloadManagerOptions {
  store: SessionJsonStore<DownloadStoreDocument>;
}

type SnapshotCause = 'restored' | 'consumed' | 'revoked';

function cloneEntry(entry: DownloadStoreEntry): DownloadStoreEntry {
  return {
    id: entry.id,
    sourcePath: entry.sourcePath,
    workspaceRoot: entry.workspaceRoot,
    filename: entry.filename,
    sizeBytes: entry.sizeBytes,
  };
}

function isDownloadStoreEntry(value: unknown): value is DownloadStoreEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<DownloadStoreEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sourcePath === 'string' &&
    typeof entry.workspaceRoot === 'string' &&
    typeof entry.filename === 'string' &&
    typeof entry.sizeBytes === 'number' &&
    Number.isFinite(entry.sizeBytes) &&
    entry.sizeBytes >= 0
  );
}

function entriesFrom(document: DownloadStoreDocument | undefined): DownloadStoreEntry[] {
  if (!document || document.version !== 1 || !Array.isArray(document.downloads)) return [];
  return document.downloads.filter(isDownloadStoreEntry).map(cloneEntry);
}

function toDownloadItem(entry: DownloadStoreEntry): DownloadItem {
  return {
    id: entry.id,
    filename: entry.filename,
    sizeBytes: entry.sizeBytes,
    href: `/d/${entry.id}`,
  };
}

/** Build the process-lifetime manager used by the extension and HTTP route. */
export function createDownloadManager(options: CreateDownloadManagerOptions): DownloadManager {
  const activeEntriesBySession = new Map<string, DownloadStoreEntry[]>();
  const publishersBySession = new Map<string, (update: DownloadUpdateEvent) => void>();
  const activeSessionById = new Map<string, string>();
  const persistenceQueues = new Map<string, Promise<void>>();
  const reservedClaimIds = new Set<string>();
  const lifecycleVersions = new Map<string, number>();

  function serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = persistenceQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    persistenceQueues.set(sessionId, settled);
    void settled.then(() => {
      if (persistenceQueues.get(sessionId) === settled) persistenceQueues.delete(sessionId);
    });
    return result;
  }

  function advanceLifecycle(sessionId: string): number {
    const version = (lifecycleVersions.get(sessionId) ?? 0) + 1;
    lifecycleVersions.set(sessionId, version);
    return version;
  }

  function removeActiveEntries(sessionId: string): void {
    const entries = activeEntriesBySession.get(sessionId);
    if (entries) {
      for (const entry of entries) {
        if (activeSessionById.get(entry.id) === sessionId) activeSessionById.delete(entry.id);
      }
    }
    activeEntriesBySession.delete(sessionId);
  }

  function replaceActiveEntries(sessionId: string, entries: DownloadStoreEntry[]): void {
    removeActiveEntries(sessionId);
    const copiedEntries = entries.map(cloneEntry);
    activeEntriesBySession.set(sessionId, copiedEntries);
    for (const entry of copiedEntries) activeSessionById.set(entry.id, sessionId);
  }

  function activeSnapshot(sessionId: string): DownloadItem[] {
    return (activeEntriesBySession.get(sessionId) ?? []).map(toDownloadItem);
  }

  function publishSnapshot(sessionId: string, cause: SnapshotCause): void {
    const publish = publishersBySession.get(sessionId);
    if (!publish) return;
    publish({ type: 'download_update', sessionId, cause, downloads: activeSnapshot(sessionId) });
  }

  function publishOffer(sessionId: string, offeredDownloadId: string): void {
    const publish = publishersBySession.get(sessionId);
    if (!publish) return;
    publish({ type: 'download_update', sessionId, cause: 'offered', offeredDownloadId, downloads: activeSnapshot(sessionId) });
  }

  async function persistEntries(sessionId: string, entries: DownloadStoreEntry[]): Promise<void> {
    if (entries.length === 0) {
      await options.store.remove(sessionId);
      return;
    }
    await options.store.write(sessionId, { version: 1, downloads: entries.map(cloneEntry) });
  }

  function nextOpaqueId(entries: DownloadStoreEntry[]): string {
    let id: string;
    do {
      id = randomUUID();
    } while (activeSessionById.has(id) || reservedClaimIds.has(id) || entries.some((entry) => entry.id === id));
    return id;
  }

  return {
    async activate(sessionId, publish): Promise<void> {
      const lifecycleVersion = advanceLifecycle(sessionId);
      await serializeSession(sessionId, async () => {
        const entries = entriesFrom(await options.store.read(sessionId));
        // A shutdown or newer activation may have happened while storage was
        // loading. Do not resurrect a session after that lifecycle changed.
        if (lifecycleVersions.get(sessionId) !== lifecycleVersion) return;
        replaceActiveEntries(sessionId, entries);
        publishersBySession.set(sessionId, publish);
        publishSnapshot(sessionId, 'restored');
      });
    },

    deactivate(sessionId): void {
      advanceLifecycle(sessionId);
      publishersBySession.delete(sessionId);
      removeActiveEntries(sessionId);
    },

    async offer(input): Promise<DownloadItem> {
      const source = await validateDownloadSource({ sourcePath: input.path, workspaceRoot: input.workspaceRoot });
      return serializeSession(input.sessionId, async () => {
        const entries = entriesFrom(await options.store.read(input.sessionId));
        const entry: DownloadStoreEntry = {
          id: nextOpaqueId(entries),
          // Keep the lexical path that the agent supplied. The route validates
          // it again at click time against this captured workspace root.
          sourcePath: input.path,
          workspaceRoot: input.workspaceRoot,
          filename: source.filename,
          sizeBytes: source.sizeBytes,
        };
        const nextEntries = [...entries, entry];
        await persistEntries(input.sessionId, nextEntries);

        if (activeEntriesBySession.has(input.sessionId)) {
          replaceActiveEntries(input.sessionId, nextEntries);
          publishOffer(input.sessionId, entry.id);
        }
        return toDownloadItem(entry);
      });
    },

    async cancel(sessionId, id): Promise<{ cancelled: boolean }> {
      return serializeSession(sessionId, async () => {
        const entries = entriesFrom(await options.store.read(sessionId));
        const entryIndex = entries.findIndex((entry) => entry.id === id);
        if (entryIndex === -1) return { cancelled: false };

        const nextEntries = entries.filter((entry) => entry.id !== id);
        await persistEntries(sessionId, nextEntries);

        if (activeEntriesBySession.has(sessionId)) {
          replaceActiveEntries(sessionId, nextEntries);
          publishSnapshot(sessionId, 'revoked');
        }
        return { cancelled: true };
      });
    },

    claim(id): Promise<DownloadClaim | undefined> {
      const sessionId = activeSessionById.get(id);
      if (!sessionId || reservedClaimIds.has(id)) return Promise.resolve(undefined);

      // Reserve before the first await so a competing request cannot enter the
      // per-session queue with the same capability.
      reservedClaimIds.add(id);
      return serializeSession(sessionId, async () => {
        try {
          const entries = entriesFrom(await options.store.read(sessionId));
          const entryIndex = entries.findIndex((entry) => entry.id === id);
          if (entryIndex === -1) return undefined;

          const entry = entries[entryIndex];
          const nextEntries = entries.filter((candidate) => candidate.id !== id);
          await persistEntries(sessionId, nextEntries);

          if (activeEntriesBySession.has(sessionId)) {
            replaceActiveEntries(sessionId, nextEntries);
            publishSnapshot(sessionId, 'consumed');
          } else if (activeSessionById.get(id) === sessionId) {
            activeSessionById.delete(id);
          }

          return {
            sessionId,
            sourcePath: entry.sourcePath,
            workspaceRoot: entry.workspaceRoot,
            filename: entry.filename,
          };
        } finally {
          reservedClaimIds.delete(id);
        }
      });
    },

    snapshot(sessionId): DownloadItem[] {
      return activeSnapshot(sessionId);
    },
  };
}
