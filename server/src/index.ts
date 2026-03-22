import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const config = await loadConfig();

  // Allow PORT env var to override config
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;

  const server = createServer(config);
  await server.start(port);

  console.log(`[pimote] Server listening on http://localhost:${port}`);
  console.log(`[pimote] WebSocket endpoint: ws://localhost:${port}/ws`);
  console.log(`[pimote] Configured roots:`);
  for (const root of config.roots) {
    console.log(`  - ${root}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
