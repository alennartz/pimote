import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { FileSessionJsonStore, gcSessionJsonStore, type SessionJsonStore } from '../session-json-store.js';
import { createFileDownloadExtension } from './index.js';
import { createDownloadManager, type CreateDownloadManagerOptions, type DownloadManager, type DownloadStoreDocument } from './manager.js';

/** Process-lifetime resources shared by the HTTP route and every pi session. */
export interface FileDownloadBootstrap {
  manager: DownloadManager;
  extensionFactory: ExtensionFactory;
}

/** Injectable side effects keep boot-time GC and ownership wiring testable. */
export interface FileDownloadBootstrapDependencies {
  createStore(storeDir: string): SessionJsonStore<DownloadStoreDocument>;
  gc(args: { storeDir: string; validSessionIds: Set<string> }): Promise<void>;
  createManager(options: CreateDownloadManagerOptions): DownloadManager;
  createExtension(options: { manager: DownloadManager }): ExtensionFactory;
}

const defaultDependencies: FileDownloadBootstrapDependencies = {
  createStore: (storeDir) => new FileSessionJsonStore<DownloadStoreDocument>(storeDir),
  gc: gcSessionJsonStore,
  createManager: createDownloadManager,
  createExtension: createFileDownloadExtension,
};

/**
 * Build the single download manager and extension factory for one server
 * process. A null allow-list means session enumeration failed, so GC is
 * deliberately skipped rather than treating every persisted registration as
 * an orphan.
 */
export async function bootstrapFileDownloads(
  args: { storeDir: string; validSessionIds: Set<string> | null },
  dependencies: FileDownloadBootstrapDependencies = defaultDependencies,
): Promise<FileDownloadBootstrap> {
  const store = dependencies.createStore(args.storeDir);
  if (args.validSessionIds) {
    await dependencies.gc({ storeDir: args.storeDir, validSessionIds: args.validSessionIds });
  }
  const manager = dependencies.createManager({ store });
  return { manager, extensionFactory: dependencies.createExtension({ manager }) };
}
