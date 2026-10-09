import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureVapidKeys } from './config.js';
import { createServer } from './server.js';
import { PimoteSessionManager, createManagerSessionFactory } from './session-manager.js';
import { SessionRecords } from './session-records.js';
import { SessionSummaryIndex } from './session-summaries.js';
import { FolderListing } from './folder-listing.js';
import { scanFolderModel, type FolderOccurrence, type FolderScanWarning, type SparseTree } from './folder-model/index.js';
import { RepoIndex } from './repo-index.js';
import { FolderRegistry } from './folder-registry.js';
import type { FolderModelPort } from './manager/types.js';
import { loadFolderSources, resolveSourcesDir } from './folder-sources/index.js';
import { createBuiltinCreator } from './folder-sources/builtin.js';
import type { FolderCreator } from './folder-sources/index.js';
import { ManagerService } from './manager/index.js';
import type { ManagerToolContext, SessionArchiveOutcome } from './manager/index.js';
import { createManagerExtension } from './manager/index.js';
import { resetManagerResourceRoot } from './manager/resources.js';
import { PushNotificationService } from './push-notification.js';
import { FilePushSubscriptionStore, WebPushSender, migratePushSubscriptionStore } from './push-infrastructure.js';
import {
  LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH,
  PIMOTE_FILE_DOWNLOAD_DIR,
  PIMOTE_MANAGER_RESOURCES_DIR,
  PIMOTE_REGISTRY_STORE_DIR,
  PIMOTE_PUSH_SUBSCRIPTIONS_PATH,
  PIMOTE_SESSION_METADATA_PATH,
  PIMOTE_SKILLS_DIR,
  PIMOTE_STATIC_HOST_DIR,
} from './paths.js';
import { FileSessionMetadataStore } from './session-metadata.js';
import { buildVoiceOrchestrator } from './voice-orchestrator-boot.js';
import { InMemoryStaticHostRegistry, FileStaticHostStore, gcStaticHostStore, createStaticHostExtension } from './static-host/index.js';
import { bootstrapFileDownloads } from './file-download/bootstrap.js';
import { getVersion } from './version.js';
import { createUpdateChecker, fetchLatestVersionFromNpm, type UpdateChecker } from './update-check.js';

export interface StartOptions {
  portOverride?: number;
}

export async function main(options: StartOptions = {}) {
  let config = await loadConfig();
  config = await ensureVapidKeys(config);

  // Allow explicit CLI override first, then PORT env var, then config
  const port = options.portOverride ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : config.port);

  const sessionSummaries = new SessionSummaryIndex();
  const sessionRecords = new SessionRecords(sessionSummaries);

  // Folder management: the repo index over the configured roots plus any
  // user-registered sources, the folder-tree port sharing its cached
  // discovery walk (one TTL stale-while-revalidate walk feeds tree and repo
  // consumers; manager tree consumers accept trees up to one TTL old), the
  // persistent curation layer above them, and the built-in creator backing
  // the dashboard's create-folder flow.
  const repoIndex = new RepoIndex(config.roots);
  const loadedSources = await loadFolderSources(await resolveSourcesDir(config.folderSourcesDir));
  for (const source of loadedSources.sources) {
    repoIndex.registerSource(source);
  }
  const folderTree: FolderModelPort = {
    tree: () => repoIndex.tree(),
  };
  const creators: FolderCreator[] = [createBuiltinCreator(), ...loadedSources.creators];
  const folderRegistry = new FolderRegistry(repoIndex, PIMOTE_REGISTRY_STORE_DIR, folderTree);

  // Initialize push notification service
  await migratePushSubscriptionStore(LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH, PIMOTE_PUSH_SUBSCRIPTIONS_PATH);
  const pushStore = new FilePushSubscriptionStore(PIMOTE_PUSH_SUBSCRIPTIONS_PATH);
  const pushSender = new WebPushSender(config.vapidPublicKey!, config.vapidPrivateKey!, config.vapidEmail || 'pimote@localhost');
  const pushNotificationService = new PushNotificationService(pushSender, pushStore);
  await pushNotificationService.initialize();

  const sessionMetadataStore = new FileSessionMetadataStore(PIMOTE_SESSION_METADATA_PATH);
  await sessionMetadataStore.initialize();

  // Static-host bootstrap: GC orphan persistence files, then construct the
  // registry/store/factory singletons shared by the session manager and the
  // HTTP route handler. The registry is process-lifetime; sessions register
  // and unregister against it as they load and shut down.
  const validSessionIds = await enumerateValidSessionIds(config.roots, sessionRecords);
  if (validSessionIds) {
    await gcStaticHostStore({ storeDir: PIMOTE_STATIC_HOST_DIR, validSessionIds });
  }
  const staticHostRegistry = new InMemoryStaticHostRegistry();
  const staticHostStore = new FileStaticHostStore(PIMOTE_STATIC_HOST_DIR);
  const staticHostFactory = createStaticHostExtension({ registry: staticHostRegistry, store: staticHostStore, skillsDir: PIMOTE_SKILLS_DIR });
  const fileDownloads = await bootstrapFileDownloads({ storeDir: PIMOTE_FILE_DOWNLOAD_DIR, validSessionIds });
  await resetManagerResourceRoot(PIMOTE_MANAGER_RESOURCES_DIR);

  const sessionManager = await PimoteSessionManager.create(config, pushNotificationService, { staticHostFactory, fileDownloadFactory: fileDownloads.extensionFactory });

  // The folder listing service: ordering, search, and windowing over the
  // registry's rows, fed by the shared per-file session-summary cache and the
  // live in-memory sessions. Rows carry identity facts immediately; git
  // status is enriched for the served rows only (window/delta scoped).
  const folderListing = new FolderListing({
    listRows: () => folderRegistry.listLazy(),
    enrichRows: (rows) => folderRegistry.enrichRows(rows),
    sessionSummaries,
    listLiveSessions: () => sessionManager.getAllSessions(),
  });

  // Global ephemeral manager: one session per client connection, built on the
  // shared model runtime with the manager extension as its only toolset. Tools
  // act only through the narrow ports of the ManagerToolContext.
  //
  // Manager-initiated session_archived events fan out to every connected
  // client exactly like the ws-handler archive_session flow; the client
  // registry is created inside createServer, so the archive port closes over
  // this ref, swapped in right after createServer returns.
  const managerClientRegistryRef: { current: Map<string, import('./ws-handler.js').WsHandler> } = { current: new Map() };
  const managerContext: ManagerToolContext = {
    sessions: {
      getAllSessions: () =>
        sessionManager.getAllSessions().map((slot) => ({
          sessionId: slot.sessionState.id,
          folderPath: slot.folderPath,
          status: slot.sessionState.status,
          needsAttention: slot.sessionState.needsAttention,
        })),
      // On-disk records for one folder: SessionRecords listing enriched
      // with the archived flag from the session metadata store, so search
      // results carry the same archived state the WS list_sessions path serves.
      listDiskSessions: async (folderPath) => {
        const records = await sessionRecords.listSessionRecords(folderPath);
        const archivedLookup = sessionMetadataStore.getArchivedLookup(records.map((record) => record.path));
        return records.map((record) => ({
          id: record.id,
          name: record.name,
          firstMessage: record.firstMessage,
          created: record.created.toISOString(),
          modified: record.modified.toISOString(),
          messageCount: record.messageCount,
          archived: archivedLookup.get(record.path) === true,
        }));
      },
      // The same open path the open_session WS command uses; a firstMessage is
      // prompted immediately and its agent run continues in the background.
      openSession: async (folderPath, firstMessage) => {
        await repoIndex.runOpenHooks(folderPath);
        const sessionId = await sessionManager.openSession(folderPath);
        const message = firstMessage?.trim();
        if (message) {
          sessionManager
            .getSession(sessionId)
            ?.session.prompt(message)
            .catch((err) => console.error('[pimote] manager firstMessage prompt failed:', err));
        }
        return sessionId;
      },
      // Canonical archive flow (ws-handler archive_session): resolve the live
      // slot's session file or the on-disk record, mark it archived, then —
      // manager-specific — evict the live slot so an archived session never
      // lingers as an open one. Broadcast mirrors the WS flow so connected
      // dashboards update immediately.
      archiveSessions: async (sessionIds: string[]): Promise<SessionArchiveOutcome[]> => {
        const folderPaths = [...new Set((await folderRegistry.list()).map((folder) => folder.path))];
        return Promise.all(
          sessionIds.map(async (sessionId): Promise<SessionArchiveOutcome> => {
            const slot = sessionManager.getSession(sessionId);
            const resolved = slot?.session.sessionFile
              ? { folderPath: slot.folderPath, sessionPath: slot.session.sessionFile }
              : await resolveSessionAcrossFolders(sessionRecords, folderPaths, sessionId);
            if (!resolved) return { sessionId, outcome: 'not_found' };

            await sessionMetadataStore.setArchived(resolved.sessionPath, true);
            // Session activity: targeted metadata invalidation for the folder —
            // covers archive runs without a live slot — and no folder delta.
            folderListing.invalidateSessionMetadata([resolved.folderPath]);
            if (slot) await sessionManager.closeSession(sessionId);
            for (const [, handler] of managerClientRegistryRef.current) {
              handler.sendToClient({ type: 'session_archived', sessionId, folderPath: resolved.folderPath, archived: true });
            }
            return { sessionId, outcome: slot ? 'open_slot_evicted' : 'archived' };
          }),
        );
      },
    },
    folders: folderRegistry,
    repos: repoIndex,
    tree: folderTree,
    config,
  };
  const managerService = new ManagerService({
    factory: createManagerSessionFactory({
      config,
      modelRuntime: sessionManager.getModelRuntime(),
      managerExtensionFactory: createManagerExtension(managerContext),
      resources: {
        root: PIMOTE_MANAGER_RESOURCES_DIR,
        registry: staticHostRegistry,
        store: staticHostStore,
        downloads: fileDownloads.manager,
        skillsDir: PIMOTE_SKILLS_DIR,
      },
    }),
  });

  // Build the voice orchestrator before createServer so each WsHandler can be
  // handed a reference. The orchestrator needs a client-registry lookup, but
  // the real registry is created inside createServer below — so we hand it a
  // small forwarding shim whose backing map is swapped in after createServer
  // returns (see review finding 6: previously a Proxy-over-Map).
  const clientRegistryRef: { current: Map<string, import('./ws-handler.js').WsHandler> } = { current: new Map() };
  const voiceBoot = buildVoiceOrchestrator({
    config,
    sessionManager,
    clientRegistry: {
      get: (clientId) => clientRegistryRef.current.get(clientId),
    },
  });

  if (!voiceBoot) {
    console.log('[voice] dormant: voice config absent (set voice.speechmuxSignalUrl and voice.speechmuxLlmWsUrl to enable)');
  }

  let updateChecker: UpdateChecker | undefined;
  if (config.updateCheck !== false) {
    const currentVersion = await getVersion();
    updateChecker = createUpdateChecker({ currentVersion, fetchLatestVersion: fetchLatestVersionFromNpm });
    void updateChecker.getStatus().then((status) => {
      if (status) {
        console.log(`[pimote] Update available: ${status.currentVersion} → ${status.latestVersion}`);
      } else {
        console.log('[pimote] Update check: no newer release found');
      }
    });
  }

  const server = await createServer(
    config,
    sessionManager,
    sessionRecords,
    pushNotificationService,
    sessionMetadataStore,
    voiceBoot?.orchestrator,
    staticHostRegistry,
    fileDownloads.manager,
    updateChecker,
    repoIndex,
    folderRegistry,
    managerService,
    creators,
    folderListing,
  );
  clientRegistryRef.current = server.clientRegistry;
  managerClientRegistryRef.current = server.clientRegistry;

  if (voiceBoot) {
    const orchestrator = voiceBoot.orchestrator;

    // Suppress push notifications for sessions currently owned by a voice call.
    // The user is on the line — we don't need to ping their phone for idle
    // signals or extension UI prompts. Pushes resume automatically once the
    // call ends and `isCallActive` flips back to false.
    pushNotificationService.setSuppressionPredicate((sessionId) => orchestrator.isCallActive(sessionId));

    // Tear down orchestrator bookkeeping when a session is being closed (idle
    // reap, explicit close). Emits call_ended{server_ended} to the owner.
    sessionManager.onBeforeSessionClose = async (sessionId) => {
      if (!orchestrator.isCallActive(sessionId)) return;
      const slot = sessionManager.getSlot(sessionId);
      const ownerClientId = slot?.connection?.connectedClientId;
      await orchestrator.endCall({ sessionId, reason: 'server_ended' });
      if (ownerClientId) {
        const handler = server.clientRegistry.get(ownerClientId);
        handler?.sendCallEndedEvent(sessionId, 'server_ended');
      }
    };
  }

  // Start idle session reaping with client connectivity check
  sessionManager.startIdleCheck(config.idleTimeout, (clientId) => server.clientRegistry.has(clientId));

  // Safety net for manager sessions whose disconnect event was missed.
  const managerReaperHandle = setInterval(() => managerService.sweepIdle(), 60_000);

  await server.start(port);

  console.log(`[pimote] Server listening on http://localhost:${port}`);
  console.log(`[pimote] WebSocket endpoint: ws://localhost:${port}/ws`);
  console.log(`[pimote] Configured roots:`);
  for (const root of config.roots) {
    console.log(`  - ${root}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[pimote] Shutting down...');
    clearInterval(managerReaperHandle);
    await voiceBoot?.shutdown();
    await sessionManager.dispose();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isDirectRun(): boolean {
  return process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

/**
 * The static-host/download boot allow-list: every session recorded in any
 * folder the folder model discovers — canonical entry paths and occurrence
 * reach paths alike, deduplicated across the whole occurrence tree, shortcut
 * descendants included.
 *
 * Returns null when the enumeration cannot be proven complete — a root-access
 * scan warning, an exhausted scan work budget, or a strict session-record
 * failure. Critical: never substitute an empty allow-list on failure; GC
 * against one would delete every persisted bundle on a transient I/O hiccup at
 * boot. The sweep is skipped instead and the next clean boot reclaims orphans.
 */
async function enumerateValidSessionIds(roots: string[], sessionRecords: SessionRecords): Promise<Set<string> | null> {
  try {
    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({
      roots,
      onWarning: (warning) => {
        warnings.push(warning);
        console.warn(`[pimote] folder scan warning at ${warning.path}:`, warning.error);
      },
    });
    if (warnings.some((warning) => warning.operation === 'budget' || isRootAccessWarning(roots, warning))) {
      console.warn('[pimote] static-host GC: scan incomplete (root access or work budget), skipping sweep this boot');
      return null;
    }
    const validSessionIds = new Set<string>();
    for (const folderPath of sessionEnumerationPaths(tree)) {
      // Strict enumeration: one unlistable folder voids completeness too.
      const records = await sessionRecords.listSessionRecords(folderPath, { failOnError: true });
      for (const record of records) validSessionIds.add(record.id);
    }
    return validSessionIds;
  } catch (err) {
    console.warn('[pimote] static-host GC: failed to enumerate sessions, skipping sweep this boot', err);
    return null;
  }
}

/**
 * Root-access warning: a root-level operation (readdir/lstat/realpath) failed
 * at a configured root — missing, non-directory, or unreadable root — so whole
 * subtrees went unenumerated and the sweep is suppressed. Everything else is
 * local: warnings below a root (unreadable markers, dangling symlinks,
 * unreadable subdirectories) and AGENTS.md content warnings (readFile) only
 * drop local discoveries and leave the sweep permitted. The scan work budget
 * (operation `'budget'`) is handled separately by the caller: an exhausted
 * budget means the tree itself is incomplete.
 */
function isRootAccessWarning(roots: readonly string[], warning: FolderScanWarning): boolean {
  return warning.operation !== 'readFile' && roots.includes(warning.path);
}

/**
 * Every folder path whose session directory may hold persisted sessions:
 * canonical entry paths plus every occurrence reach path, deduplicated in
 * first-discovery order across the whole occurrence tree, shortcut descendants
 * included. Reach paths belong here because pi's session-directory encoding is
 * lexical: a session opened through a symlink alias (or recorded under a
 * pre-canonical path before the folder-model rename) lives in that alias's
 * session directory, not the canonical one — enumerating only canonical paths
 * lets the sweep delete those sessions' hosting/download registrations on
 * every boot.
 */
function sessionEnumerationPaths(tree: SparseTree): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };
  const visit = (occurrence: FolderOccurrence): void => {
    add(occurrence.entry.path);
    add(occurrence.path);
    occurrence.children.forEach(visit);
  };
  tree.occurrences.forEach(visit);
  return paths;
}

/** Resolve a session id to its on-disk file path and owning folder,
 *  scanning the given folders — the manager's archive path when no live slot
 *  holds the id. */
async function resolveSessionAcrossFolders(
  sessionRecords: SessionRecords,
  folderPaths: string[],
  sessionId: string,
): Promise<{ folderPath: string; sessionPath: string } | undefined> {
  for (const folderPath of folderPaths) {
    const sessionPath = await sessionRecords.resolveSessionPath(folderPath, sessionId);
    if (sessionPath) return { folderPath, sessionPath };
  }
  return undefined;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
