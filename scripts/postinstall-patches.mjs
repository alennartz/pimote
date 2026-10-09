#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pathParts = packageRoot.split('/node_modules/');
const installRoot = pathParts.length > 1 ? pathParts[0] : packageRoot;
const patchDir = join(packageRoot, 'patches');
const patchPackageEntrypoint = join(installRoot, 'node_modules', 'patch-package', 'index.js');

async function listPatchFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.patch')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * patch-package names files "<name>+<version>.patch"; scoped packages become
 * "@scope+name+version.patch" (the "/" in the name replaced by "+").
 */
function parsePatchFilename(fileName) {
  const stem = fileName.replace(/\.patch$/, '');
  if (stem.startsWith('@')) {
    const parts = stem.split('+');
    const version = parts.pop();
    return { name: parts.join('/'), version };
  }
  const versionStart = stem.lastIndexOf('+');
  return { name: stem.slice(0, versionStart), version: stem.slice(versionStart + 1) };
}

/**
 * patch-package exits 0 when a patch file names a version that is not
 * installed, so the error stays silent. Check every patch file against the
 * installed package version and report mismatches before applying anything.
 */
async function checkPatchTargets(patchFiles) {
  const mismatches = [];
  for (const fileName of patchFiles) {
    const { name, version } = parsePatchFilename(fileName);
    let installed;
    try {
      const manifest = await readFile(join(installRoot, 'node_modules', name, 'package.json'), 'utf8');
      installed = JSON.parse(manifest).version;
    } catch {
      installed = undefined;
    }
    if (installed !== version) {
      mismatches.push(
        `[pimote] ${fileName}: patch targets ${name}@${version}, but ${installed === undefined ? `${name} is not installed` : `installed version is ${installed}`}`,
      );
    }
  }
  return mismatches;
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
  const patchFiles = await listPatchFiles(patchDir);
  if (patchFiles.length === 0) {
    return;
  }

  const mismatches = await checkPatchTargets(patchFiles);
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) {
      console.error(mismatch);
    }
    console.error('[pimote] Regenerate stale patches: edit node_modules, then run `npx patch-package <pkg> --patch-dir patches`.');
    process.exit(1);
  }

  if (!(await exists(patchPackageEntrypoint))) {
    throw new Error(`[pimote] Could not find patch-package at ${patchPackageEntrypoint}`);
  }

  const patchDirArg = patchDir.startsWith(installRoot) ? patchDir.slice(installRoot.length + 1) : patchDir;
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
