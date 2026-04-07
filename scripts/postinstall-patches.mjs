#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pathParts = packageRoot.split('/node_modules/');
const installRoot = pathParts.length > 1 ? pathParts[0] : packageRoot;
const patchDir = join(packageRoot, 'patches');
const patchPackageEntrypoint = join(installRoot, 'node_modules', 'patch-package', 'index.js');

async function hasPatchFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.patch'));
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await hasPatchFiles(patchDir))) {
    return;
  }

  if (!(await exists(patchPackageEntrypoint))) {
    throw new Error(`[pimote] Could not find patch-package at ${patchPackageEntrypoint}`);
  }

  const patchDirArg = relative(installRoot, patchDir) || patchDir;
  const result = spawnSync(process.execPath, [patchPackageEntrypoint, '--patch-dir', patchDirArg], {
    cwd: installRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
