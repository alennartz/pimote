import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { PimoteSessionManager } from './session-manager.js';
import { FolderIndex } from './folder-index.js';

async function main() {
  const config = await loadConfig();

  // Allow PORT env var to override config
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;

  const sessionManager = new PimoteSessionManager(config);
  const folderIndex = new FolderIndex(config.roots);

  const server = createServer(config, sessionManager, folderIndex);

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
