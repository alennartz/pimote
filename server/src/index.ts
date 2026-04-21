import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureVapidKeys } from './config.js';
import { createServer } from './server.js';
import { PimoteSessionManager } from './session-manager.js';
import { FolderIndex } from './folder-index.js';
import { PushNotificationService } from './push-notification.js';
import { FilePushSubscriptionStore, WebPushSender, migratePushSubscriptionStore } from './push-infrastructure.js';
import { LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH, PIMOTE_PUSH_SUBSCRIPTIONS_PATH, PIMOTE_SESSION_METADATA_PATH } from './paths.js';
import { FileSessionMetadataStore } from './session-metadata.js';
import { buildVoiceOrchestrator } from './voice-orchestrator-boot.js';

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

  const sessionManager = new PimoteSessionManager(config, pushNotificationService);

  // Build the voice orchestrator before createServer so each WsHandler can be
  // handed a reference. The orchestrator holds its own client-registry handle,
  // populated below once the server exists (chicken-and-egg: the registry is
  // created inside createServer).
  const clientRegistryRef: { current: Map<string, import('./ws-handler.js').WsHandler> } = { current: new Map() };
  const voiceBoot = buildVoiceOrchestrator({
    config,
    sessionManager,
    clientRegistry: new Proxy(new Map(), {
      get(_t, p, _r) {
        return Reflect.get(clientRegistryRef.current, p, clientRegistryRef.current);
      },
    }) as Map<string, import('./ws-handler.js').WsHandler>,
  });

  const server = await createServer(config, sessionManager, folderIndex, pushNotificationService, sessionMetadataStore, voiceBoot.orchestrator);
  clientRegistryRef.current = server.clientRegistry;
  await voiceBoot.orchestrator.start();

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
    await voiceBoot.shutdown();
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
