#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces whose declared version follows the root package version. */
const syncedWorkspaces = ['server', 'client', join('packages', 'sdk')];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Copy the root package version into every synced workspace manifest.
 * Returns one row per workspace so callers can report what moved.
 */
async function syncVersions(rootDir = packageRoot) {
  const root = await readJson(join(rootDir, 'package.json'));
  const results = [];
  for (const workspace of syncedWorkspaces) {
    const manifestPath = join(rootDir, workspace, 'package.json');
    const manifest = await readJson(manifestPath);
    if (manifest.version === root.version) {
      results.push({ workspace, changed: false });
      continue;
    }
    const previous = manifest.version;
    manifest.version = root.version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    results.push({ workspace, changed: true, previous });
  }
  return results;
}

export { syncedWorkspaces, syncVersions };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncVersions()
    .then((results) => {
      for (const { workspace, changed, previous } of results) {
        if (changed) console.log(`[pimote] ${workspace}: ${previous} -> version synced from root`);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
