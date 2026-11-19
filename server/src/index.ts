import { resolve } from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { watch as watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { DefaultPackageManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureVapidKeys, expandHomePath, managerRootPlacementError } from './config.js';
import { ConfigRuntime } from './config-runtime.js';
import { GlobalSettingsCatalog } from './global-settings.js';
import { createPimoteExtensionHost } from './pimote-extensions/index.js';
import { closeSessionForObservers, WsHandler } from './ws-handler.js';
import { UserProfiles } from './user-profiles.js';
import { createServer } from './server.js';
import { PimoteSessionManager, runSlotLifecycle } from './session-manager.js';
import { SessionRecords, resolveSessionAcrossFolders } from './session-records.js';
import { SessionSummaryIndex } from './session-summaries.js';
import { FolderListing } from './folder-listing.js';
import { scanFolderModel, type FolderOccurrence, type FolderScanWarning, type SparseTree } from './folder-model/index.js';
import { RepoIndex } from './repo-index.js';
import { FolderRegistry } from './folder-registry.js';
import type { FolderModelPort } from './folder-registry.js';
import { HubWorktrees, defaultWorktreeGitRunner } from './hub-worktrees.js';
import { HubActivity } from './hub-activity.js';
import { listExternalPiWorkingDirectories } from './takeover.js';
import { createCodeFolder } from './folder-create.js';
import { seedManagerRoot } from './manager/index.js';
import type { ManagerToolContext, SessionArchiveOutcome, SessionResumeOutcome } from './manager/index.js';
import { createManagerExtension } from './manager/index.js';
import { createPimoteDocsExtension } from './pimote-docs/index.js';
import { PushNotificationService } from './push-notification.js';
import { FilePushSubscriptionStore, WebPushSender, migratePushSubscriptionStore } from './push-infrastructure.js';
import {
  LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH,
  PIMOTE_CONFIG_PATH,
  PIMOTE_EXTENSIONS_DIR,
  PIMOTE_FILE_DOWNLOAD_DIR,
  PIMOTE_REGISTRY_STORE_DIR,
  PIMOTE_PUSH_SUBSCRIPTIONS_PATH,
  PIMOTE_SESSION_METADATA_PATH,
  PIMOTE_STATIC_HOST_DIR,
  PIMOTE_USER_PROFILES_PATH,
  PIMOTE_THEMES_PATH,
} from './paths.js';
import { FileSessionMetadataStore } from './session-metadata.js';
import { buildVoiceOrchestrator } from './voice-orchestrator-boot.js';
import { InMemoryStaticHostRegistry, FileStaticHostStore, gcStaticHostStore, createStaticHostExtension } from './static-host/index.js';
import { bootstrapFileDownloads } from './file-download/bootstrap.js';
import { getVersion } from './version.js';
import { createUpdateChecker, fetchLatestVersionFromNpm, type UpdateChecker } from './update-check.js';
import { ThemeCatalog } from './theme-catalog.js';
import { builtinThemeDefinitions } from './builtin-themes.js';

export interface StartOptions {
  portOverride?: number;
}

export async function main(options: StartOptions = {}) {
  let config = await loadConfig();
  config = await ensureVapidKeys(config);
  // Manager-root boot contract (plan: manager-lifecycle; review finding 1):
  // create the manager persona folder when absent, canonicalize it, guard its
  // placement, then seed. The guard rejects a manager root that is or contains
  // the home directory — the seeded persona AGENTS.md would load there as
  // ancestor context for every pi session below it. A manager root inside a
  // scan root is legal: the repo index keeps its entry out of listings.
  await mkdir(config.managerRoot, { recursive: true });
  config = { ...config, managerRoot: await realpath(config.managerRoot) };
  const placementError = managerRootPlacementError(config.managerRoot, await canonicalizeForPlacement(homedir()));
  if (placementError) throw new Error(placementError);
  await seedManagerRoot(config.managerRoot);

  // Allow explicit CLI override first, then PORT env var, then config
  const port = options.portOverride ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : config.port);

  // Native Pimote configuration is the single live source for dynamic policy.
  // Startup-only fields remain captured in `config` by the consumers that own
  // listeners, roots, push, and voice transport.
  const voiceOrchestratorRef: { current: ReturnType<typeof buildVoiceOrchestrator> } = { current: null };
  const configRuntime = new ConfigRuntime({
    configPath: PIMOTE_CONFIG_PATH,
    config,
    voiceAvailable: () => voiceOrchestratorRef.current !== null,
  });
  const agentDir = getAgentDir();
  const packageSettings = SettingsManager.create(process.cwd(), agentDir);
  const packageManager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager: packageSettings });
  const pimoteExtensionHost = createPimoteExtensionHost({ extensionDirectory: PIMOTE_EXTENSIONS_DIR, packageManager });

  const sessionSummaries = new SessionSummaryIndex();
  const sessionRecords = new SessionRecords(sessionSummaries);

  // Folder management: the repo index over the configured roots plus any
  // user-registered sources, the folder-tree port sharing its cached
  // discovery walk (one TTL stale-while-revalidate walk feeds tree and repo
  // consumers; manager tree consumers accept trees up to one TTL old), the
  // persistent curation layer above them, and the core creator backing the
  // dashboard's create-folder flow.
  // The manager root is never a folder row (owner ruling, review finding 10):
  // post-detection exclusion at listing assembly, not a discovery carve-out —
  // discovery may see the entry; listings and trees never surface it.
  const repoIndex = new RepoIndex(config.roots, { excludeEntryPaths: [config.managerRoot] });
  const initialPimoteRegistry = await pimoteExtensionHost.start();
  for (const diagnostic of initialPimoteRegistry.diagnostics) {
    console.warn(`[pimote-extensions] ${diagnostic.path}: ${diagnostic.message}`);
  }
  if (initialPimoteRegistry.sources.length > 0) await repoIndex.replaceUserSources(initialPimoteRegistry.sources);

  const themeCatalog = new ThemeCatalog({
    builtinThemes: builtinThemeDefinitions(),
    extensionFiles: initialPimoteRegistry.themeFiles ?? [],
    userFile: PIMOTE_THEMES_PATH,
    defaultThemeId: config.defaultTheme ?? 'pimote/light',
    reader: {
      read: (path) => readFile(path, 'utf8'),
      watch: (path, listener) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watcher = watchFile(resolve(path, '..'), { persistent: false }, (_event, filename) => {
          if (!filename || filename.toString() !== path.split('/').pop()) return;
          clearTimeout(timer);
          timer = setTimeout(listener, 25);
        });
        return () => {
          clearTimeout(timer);
          watcher.close();
        };
      },
    },
  });
  await themeCatalog.load();
  const folderTree: FolderModelPort = {
    tree: () => repoIndex.tree(),
  };

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
  const validSessionIds = await enumerateValidSessionIds(config.roots, config.managerRoot, sessionRecords);
  if (validSessionIds) {
    await gcStaticHostStore({ storeDir: PIMOTE_STATIC_HOST_DIR, validSessionIds });
  }

  // Per-user open-session profiles: load the store, then prune entries naming
  // sessions the boot sweep could not validate (same sweep as the static-host
  // store; a failed sweep keeps every entry).
  const userProfiles = new UserProfiles(PIMOTE_USER_PROFILES_PATH);
  await userProfiles.load();
  if (validSessionIds) {
    await userProfiles.gc(validSessionIds);
  }
  await userProfiles.dropAllViews();
  const staticHostRegistry = new InMemoryStaticHostRegistry();
  const staticHostStore = new FileStaticHostStore(PIMOTE_STATIC_HOST_DIR);
  const staticHostFactory = createStaticHostExtension({ registry: staticHostRegistry, store: staticHostStore });
  const fileDownloads = await bootstrapFileDownloads({ storeDir: PIMOTE_FILE_DOWNLOAD_DIR, validSessionIds });
  const managerContextBinding = new ManagerContextBinding();
  const managerExtensionFactory: ExtensionFactory = (pi) => createManagerExtension(managerContextBinding.get())(pi);
  // Voice is constructed after the session manager. Keep the predicate live so
  // replacement sessions read their current slot session ID.
  const sessionManager = await PimoteSessionManager.create(config, pushNotificationService, {
    configSupplier: () => configRuntime.snapshot(),
    staticHostFactory,
    fileDownloadFactory: fileDownloads.extensionFactory,
    managerExtensionFactory,
    pimoteDocsFactory: createPimoteDocsExtension(),
    isVoiceModeActive: (slot) => voiceOrchestratorRef.current?.orchestrator.isCallActive(slot.sessionState.id) ?? false,
  });

  // The folder registry is constructed after the session manager so the hub
  // disband guard can close idle hub sessions through the manager's canonical
  // close lifecycle without the registry ever holding the session manager
  // itself (plan: hub-member-representation Step 2).
  const folderRegistry = new FolderRegistry(
    repoIndex,
    PIMOTE_REGISTRY_STORE_DIR,
    folderTree,
    new HubWorktrees(defaultWorktreeGitRunner),
    new HubActivity({
      closeIdleSessionsAt: (paths) => sessionManager.closeIdleSessionsAt(paths),
      externalPiWorkingDirectories: listExternalPiWorkingDirectories,
    }),
  );

  // The folder listing service: ordering, search, and windowing over the
  // registry's rows, fed by the shared per-file session-summary cache and the
  // live in-memory sessions. Rows carry identity facts immediately; git
  // status is enriched for the served rows only (window/delta scoped).
  const folderListing = new FolderListing({
    listRows: () => folderRegistry.listLazy(),
    enrichRows: (rows) => folderRegistry.enrichRows(rows),
    sessionSummaries,
    archivedLookup: (paths) => sessionMetadataStore.getArchivedLookup(paths),
    listLiveSessions: () => sessionManager.getAllSessions(),
  });

  // Manager tools use startup-built ports through ordinary persisted sessions.
  // Manager-initiated archive-state events fan out to every connected client
  // exactly like the ws-handler archive_session flow; the client registry is
  // created inside createServer, so these ports close over this ref, swapped
  // in right after createServer returns.
  const managerClientRegistryRef: { current: Map<string, import('./ws-handler.js').WsHandler> } = { current: new Map() };
  /** Manager mutations share the session manager's lifecycle lock with the
   *  WebSocket archive/open paths. */
  const runManagerSessionOperation = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => sessionManager.withSessionOperation(sessionId, operation);

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
      listDiskSessions: async (folderPath, signal) => {
        const records = await sessionRecords.listSessionRecords(folderPath, { signal });
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
        const slot = sessionManager.getSession(sessionId);
        // Publish availability before dispatching the optional prompt. Every
        // connected client can attach while the first run is still starting.
        await WsHandler.broadcastSessionOpened(sessionId, slot?.folderPath ?? folderPath, sessionManager, folderRegistry, managerClientRegistryRef.current);
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
        const knownFolderPaths = (await folderRegistry.listLazy()).map((folder) => folder.path);
        return Promise.all(
          sessionIds.map((sessionId) =>
            runManagerSessionOperation(sessionId, async (): Promise<SessionArchiveOutcome> => {
              const slot = sessionManager.getSession(sessionId);
              // Folderless lookup is the shared `resolveSessionAcrossFolders`
              // rule: known folders plus the manager root, deduplicated.
              const resolved = slot?.session.sessionFile
                ? { folderPath: slot.folderPath, sessionFilePath: slot.session.sessionFile }
                : await resolveSessionAcrossFolders(sessionRecords, knownFolderPaths, config.managerRoot, sessionId);
              if (!resolved) return { sessionId, outcome: 'not_found' };

              // Mark the record before runtime disposal closes the slot. A
              // concurrent open then sees session_archived instead of attaching
              // to a runtime that is already closing. Admit the close first so
              // a reset in progress cannot leave a half-archived record.
              if (slot) {
                await runSlotLifecycle(slot, 'close', async () => {
                  await sessionMetadataStore.setArchived(resolved.sessionFilePath, true);
                  await closeSessionForObservers(sessionManager, managerClientRegistryRef.current, sessionId, slot, 'archived');
                });
              } else {
                await sessionMetadataStore.setArchived(resolved.sessionFilePath, true);
              }
              // Session activity: targeted metadata invalidation for the folder —
              // covers archive runs without a live slot — and no folder delta.
              folderListing.invalidateSessionMetadata([resolved.folderPath]);
              for (const [, handler] of managerClientRegistryRef.current) {
                handler.sendToClient({ type: 'session_archived', sessionId, folderPath: resolved.folderPath, archived: true });
              }
              return { sessionId, outcome: slot ? 'open_slot_evicted' : 'archived' };
            }),
          ),
        );
      },
      /** Explicit manager action for reopening an existing record. The
       *  original file is opened while its archive flag is still set, so a
       *  concurrent ordinary open cannot attach to it halfway through the
       *  transition. The flag is cleared only after the original runtime is
       *  live; a failure therefore leaves the record archived and closed. */
      resumeSession: async (sessionId: string): Promise<SessionResumeOutcome> =>
        runManagerSessionOperation(sessionId, async (): Promise<SessionResumeOutcome> => {
          const knownFolderPaths = (await folderRegistry.listLazy()).map((folder) => folder.path);
          const existing = sessionManager.getSession(sessionId);
          if (existing && !existing.session.sessionFile) {
            await WsHandler.broadcastSessionOpened(sessionId, existing.folderPath, sessionManager, folderRegistry, managerClientRegistryRef.current);
            return { sessionId, folderPath: existing.folderPath, outcome: 'already_open' };
          }
          const resolved = existing?.session.sessionFile
            ? { folderPath: existing.folderPath, sessionFilePath: existing.session.sessionFile }
            : await resolveSessionAcrossFolders(sessionRecords, knownFolderPaths, config.managerRoot, sessionId);
          if (!resolved) return { sessionId, outcome: 'not_found' };

          const archived = sessionMetadataStore.isArchived(resolved.sessionFilePath);
          if (existing && !archived) {
            await WsHandler.broadcastSessionOpened(sessionId, existing.folderPath, sessionManager, folderRegistry, managerClientRegistryRef.current);
            return { sessionId, folderPath: existing.folderPath, outcome: 'already_open' };
          }

          let openedId = sessionId;
          let slot = existing;
          if (!slot) {
            await repoIndex.runOpenHooks(resolved.folderPath);
            try {
              openedId = await sessionManager.openSession(resolved.folderPath, resolved.sessionFilePath);
            } catch (error) {
              const failedSlot = sessionManager.getSession(sessionId);
              if (failedSlot) {
                try {
                  await closeSessionForObservers(sessionManager, managerClientRegistryRef.current, sessionId, failedSlot, archived ? 'archived' : undefined);
                } catch (cleanupError) {
                  throw new AggregateError([error, cleanupError], 'Session resume opening and cleanup failed', { cause: cleanupError });
                }
              }
              throw error;
            }
            if (openedId !== sessionId) {
              const error = new Error(`session resume changed the session id from ${sessionId} to ${openedId}`);
              try {
                await sessionManager.closeSession(openedId);
              } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Session resume validation and cleanup failed', { cause: cleanupError });
              }
              throw error;
            }
            slot = sessionManager.getSession(openedId);
            if (!slot) {
              throw new Error(`session resume did not produce a live slot for ${sessionId}`);
            }
          }

          const folderPath = slot?.folderPath ?? resolved.folderPath;
          if (archived) {
            try {
              await sessionMetadataStore.setArchived(resolved.sessionFilePath, false);
            } catch (error) {
              // A rejected metadata transaction preserves the original archived entry.
              // Close the runtime without replacing its archivedAt timestamp.
              if (slot) {
                try {
                  await closeSessionForObservers(sessionManager, managerClientRegistryRef.current, openedId, slot, 'archived');
                } catch (cleanupError) {
                  throw new AggregateError([error, cleanupError], 'Session resume metadata and cleanup failed', { cause: cleanupError });
                }
              }
              throw error;
            }
            folderListing.invalidateSessionMetadata([...new Set([resolved.folderPath, folderPath])]);
            for (const [, handler] of managerClientRegistryRef.current) {
              handler.sendToClient({ type: 'session_archived', sessionId, folderPath, archived: false });
            }
          }
          if (slot) {
            await WsHandler.broadcastSessionOpened(openedId, folderPath, sessionManager, folderRegistry, managerClientRegistryRef.current);
            WsHandler.broadcastSidebarUpdate(openedId, folderPath, sessionManager, managerClientRegistryRef.current);
          }
          return { sessionId, folderPath, outcome: 'resumed' };
        }),
    },
    folders: folderRegistry,
    repos: repoIndex,
    // Code-folder creation stays in Pimote core. The manager and WebSocket
    // surfaces share this operation and its best-effort AGENTS.md seed.
    creators: {
      create: (input) => createCodeFolder(input.root, input.name, input.body),
    },
    // Folder-change fan-out for manager folder creations (`pimote_create_persona`):
    // the same delta channel the ws-handler `create_folder` flow uses. The tool
    // pairs it with `repos.invalidateListing()` so the delta carries the new row.
    notifyFoldersChanged: (changedPaths) => {
      WsHandler.broadcastFoldersChanged(folderListing, changedPaths, [], managerClientRegistryRef.current);
    },
    config,
  };
  managerContextBinding.bind(managerContext);

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
  voiceOrchestratorRef.current = voiceBoot;

  if (!voiceBoot) {
    console.log('[voice] dormant: voice config absent (set voice.speechmuxSignalUrl and voice.speechmuxLlmWsUrl to enable)');
  }

  const reloadPimoteExtensions = async (): Promise<void> => {
    try {
      await packageSettings.reload();
    } catch (error) {
      console.warn(`[pimote-extensions] package settings reload failed: ${String(error)}`);
    }
    const registry = await pimoteExtensionHost.reload();
    for (const diagnostic of registry.diagnostics) {
      console.warn(`[pimote-extensions] ${diagnostic.path}: ${diagnostic.message}`);
    }
    await repoIndex.replaceUserSources(registry.sources);
    await themeCatalog.replaceExtensionFiles(registry.themeFiles ?? []);
  };
  const globalSettings = {
    manifest: () =>
      new GlobalSettingsCatalog({
        home: homedir(),
        agentDir,
        configPath: PIMOTE_CONFIG_PATH,
        settingsFiles: configRuntime.snapshot().settingsFiles,
        extensionFiles: pimoteExtensionHost.getRegistry().settingsFiles,
      }).snapshot(),
    configRuntime,
    capabilities: () => configRuntime.capabilities(),
    themeDefaultChanged: (defaultThemeId: string) => themeCatalog.setDefaultTheme(defaultThemeId).then(() => undefined),
    themeCatalog,
    reloadPimoteExtensions,
  };

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
    folderListing,
    globalSettings,
    userProfiles,
  );
  clientRegistryRef.current = server.clientRegistry;
  managerClientRegistryRef.current = server.clientRegistry;

  if (voiceBoot) {
    const orchestrator = voiceBoot.orchestrator;

    // Suppress push notifications for sessions currently in a voice call.
    // The user is on the line — we don't need to ping their phone for idle
    // signals or extension UI prompts. Pushes resume automatically once the
    // call ends and `isCallActive` flips back to false.
    pushNotificationService.setSuppressionPredicate((sessionId) => orchestrator.isCallActive(sessionId));

    // Tear down orchestrator bookkeeping when a session is being closed.
    sessionManager.onBeforeSessionClose = async (sessionId) => {
      if (!orchestrator.isCallActive(sessionId)) return;
      const holder = orchestrator.callHolder.get(sessionId);
      await orchestrator.endCall({ sessionId, reason: 'server_ended' });
      if (holder) server.clientRegistry.get(holder)?.sendCallEndedEvent(sessionId, 'server_ended');
    };
  }

  // Start idle session reaping while no observers or voice call holders remain.
  sessionManager.startIdleCheck(() => configRuntime.snapshot().idleTimeout, voiceBoot ? (sessionId) => voiceBoot.orchestrator.isCallActive(sessionId) : undefined);

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
    await voiceBoot?.shutdown();
    await pimoteExtensionHost.shutdown();
    await themeCatalog.close();
    await sessionManager.dispose();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Canonicalize one path for the manager-root placement guard. An unresolvable
 *  path falls back to its tilde-expanded form, so the comparison stays
 *  best-effort. */
async function canonicalizeForPlacement(path: string): Promise<string> {
  const absolute = expandHomePath(path, homedir());
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Init-only indirection breaks the session-manager/context construction cycle.
 * Bound once before createServer exposes any session commands. */
class ManagerContextBinding {
  private context: ManagerToolContext | undefined;

  bind(context: ManagerToolContext): void {
    if (this.context) throw new Error('Manager context is already bound');
    this.context = context;
  }

  get(): ManagerToolContext {
    if (!this.context) throw new Error('Manager context is not bound');
    return this.context;
  }
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
async function enumerateValidSessionIds(roots: string[], managerRoot: string, sessionRecords: SessionRecords): Promise<Set<string> | null> {
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
    for (const folderPath of new Set([...sessionEnumerationPaths(tree), managerRoot])) {
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

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
