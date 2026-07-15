import type { DownloadItem, DownloadUpdateEvent } from '../../../shared/dist/index.js';
import type { SessionJsonStore } from '../session-json-store.js';

export type { DownloadItem, DownloadUpdateCause, DownloadUpdateEvent } from '../../../shared/dist/index.js';

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
  claim(id: string): Promise<DownloadClaim | undefined>;
  snapshot(sessionId: string): DownloadItem[];
}

export interface CreateDownloadManagerOptions {
  store: SessionJsonStore<DownloadStoreDocument>;
}

/** Build the process-lifetime manager used by the extension and HTTP route. */
export function createDownloadManager(_options: CreateDownloadManagerOptions): DownloadManager {
  throw new Error('not implemented');
}
