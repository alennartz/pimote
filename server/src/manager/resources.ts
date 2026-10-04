import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createStaticHostExtension, type StaticHostRegistry, type StaticHostStore } from '../static-host/index.js';
import { createFileDownloadExtension, type DownloadManager } from '../file-download/index.js';
import { validateDownloadSource } from '../file-download/source.js';

/** Links survive disconnect for one day, but not a server restart. */
export const MANAGER_RESOURCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ManagerResourceOptions {
  root: string;
  registry: StaticHostRegistry;
  store: StaticHostStore;
  downloads: DownloadManager;
  skillsDir?: string;
  retentionMs?: number;
}

/** Snapshot only published artifacts, never the manager's whole workspace. */
export async function createManagerResources(options: ManagerResourceOptions): Promise<{
  extensionFactories: ExtensionFactory[];
  release(sessionId: string): void;
  /** Reclaim failed session initialization immediately, without a lease. */
  discard(sessionId: string): Promise<void>;
}> {
  await mkdir(options.root, { recursive: true });
  const artifactsDir = await mkdtemp(join(options.root, 'artifacts-'));

  async function snapshotFolder(folder: string): Promise<string> {
    if (!isAbsolute(folder)) throw new Error('folder must be an absolute path');
    if (!(await stat(folder)).isDirectory() || !(await stat(join(folder, 'index.html'))).isFile()) {
      throw new Error('bundle must be a directory containing index.html');
    }
    const destination = await mkdtemp(join(artifactsDir, 'bundle-'));
    try {
      await cp(folder, destination, { recursive: true, dereference: true });
      return destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async function snapshotFile(path: string, workspaceRoot: string): Promise<string> {
    const source = await validateDownloadSource({ sourcePath: path, workspaceRoot });
    const destinationDir = await mkdtemp(join(artifactsDir, 'download-'));
    const destination = join(destinationDir, source.filename);
    try {
      await cp(source.resolvedPath, destination);
      return destination;
    } catch (error) {
      await rm(destinationDir, { recursive: true, force: true });
      throw error;
    }
  }

  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    extensionFactories: [
      createStaticHostExtension({
        registry: options.registry,
        store: options.store,
        skillsDir: options.skillsDir,
        retainOnShutdown: true,
        prepareFolder: snapshotFolder,
      }),
      createFileDownloadExtension({ manager: options.downloads, retainOnShutdown: true, preparePath: snapshotFile }),
    ],
    release(sessionId) {
      if (released) return;
      released = true;
      // Unsubscribe from the disposed EventBus without revoking pending links.
      options.downloads.detach(sessionId);
      timer = setTimeout(() => {
        void expire(sessionId).catch((error) => console.error('[pimote] manager artifact cleanup failed', error));
      }, options.retentionMs ?? MANAGER_RESOURCE_RETENTION_MS);
      timer.unref();
    },
    async discard(sessionId) {
      released = true;
      if (timer) clearTimeout(timer);
      await expire(sessionId);
    },
  };

  async function expire(sessionId: string): Promise<void> {
    options.registry.unregisterAllForSession(sessionId);
    const pending = options.downloads.snapshot(sessionId);
    // Revoke capabilities before asynchronous persistence cleanup, even if
    // one store fails. Always attempt every cleanup operation.
    options.downloads.deactivate(sessionId);
    const results = await Promise.allSettled([
      ...pending.map((item) => options.downloads.cancel(sessionId, item.id)),
      options.store.remove(sessionId),
      rm(artifactsDir, { recursive: true, force: true }),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

/** Ephemeral manager links are not restored; reclaim last boot's snapshots. */
export async function resetManagerResourceRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}
