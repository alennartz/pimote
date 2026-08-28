import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureVapidKeys } from './config.js';
import { createServer } from './server.js';
import { PimoteSessionManager } from './session-manager.js';
import { FolderIndex } from './folder-index.js';
import { PushNotificationService } from './push-notification.js';
import { FilePushSubscriptionStore, WebPushSender, migratePushSubscriptionStore } from './push-infrastructure.js';
import { LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH, PIMOTE_FILE_DOWNLOAD_DIR, PIMOTE_PUSH_SUBSCRIPTIONS_PATH, PIMOTE_SESSION_METADATA_PATH, PIMOTE_STATIC_HOST_DIR } from './paths.js';
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

  const folderIndex = new FolderIndex(config.roots);

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
  let validSessionIds: Set<string> | null = new Set<string>();
  try {
    // GC must only run from a complete session enumeration. The normal
    // FolderIndex APIs intentionally degrade to partial results for UI calls;
    // boot uses strict mode so an inaccessible root/session directory skips
    // the sweep instead of treating omitted sessions as orphans.
    const folders = await folderIndex.scan({ failOnError: true });
    for (const folder of folders) {
      const records = await folderIndex.listSessionRecords(folder.path, { failOnError: true });
      for (const rec of records) validSessionIds.add(rec.id);
    }
  } catch (err) {
    // Critical: do NOT run GC with an empty allow-list — that would delete
    // every persisted bundle on a transient I/O hiccup at boot. Skip the
    // sweep entirely and let the next clean boot reclaim orphans.
    console.warn('[pimote] static-host GC: failed to enumerate sessions, skipping sweep this boot', err);
    validSessionIds = null;
  }
  if (validSessionIds) {
    await gcStaticHostStore({ storeDir: PIMOTE_STATIC_HOST_DIR, validSessionIds });
  }
  const staticHostRegistry = new InMemoryStaticHostRegistry();
  const staticHostStore = new FileStaticHostStore(PIMOTE_STATIC_HOST_DIR);
  const staticHostFactory = createStaticHostExtension({ registry: staticHostRegistry, store: staticHostStore });
  const fileDownloads = await bootstrapFileDownloads({ storeDir: PIMOTE_FILE_DOWNLOAD_DIR, validSessionIds });

  const sessionManager = await PimoteSessionManager.create(config, pushNotificationService, { staticHostFactory, fileDownloadFactory: fileDownloads.extensionFactory });

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
    folderIndex,
    pushNotificationService,
    sessionMetadataStore,
    voiceBoot?.orchestrator,
    staticHostRegistry,
    fileDownloads.manager,
    updateChecker,
  );
  clientRegistryRef.current = server.clientRegistry;

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

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
