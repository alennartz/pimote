#!/usr/bin/env node

import { runCli } from '../server/dist/cli.js';

runCli().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
