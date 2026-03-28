import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, ensureVapidKeys } from './config.js';
import { createServer } from './server.js';
import { PimoteSessionManager } from './session-manager.js';
import { FolderIndex } from './folder-index.js';
import { PushNotificationService } from './push-notification.js';
import { FilePushSubscriptionStore, WebPushSender } from './push-infrastructure.js';

async function main() {
  let config = await loadConfig();
  config = await ensureVapidKeys(config);

  // Allow PORT env var to override config
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;

  const sessionManager = new PimoteSessionManager(config);
  const folderIndex = new FolderIndex(config.roots);

  // Initialize push notification service
  const pushStore = new FilePushSubscriptionStore(
    join(homedir(), '.config', 'pimote', 'push-subscriptions.json'),
  );
  const pushSender = new WebPushSender(
    config.vapidPublicKey!,
    config.vapidPrivateKey!,
    config.vapidEmail || 'pimote@localhost',
  );
  const pushNotificationService = new PushNotificationService(pushSender, pushStore);
  await pushNotificationService.initialize();

  const server = createServer(config, sessionManager, folderIndex, pushNotificationService);

  // Start idle session reaping
  sessionManager.startIdleCheck(config.idleTimeout);

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
    await sessionManager.dispose();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
