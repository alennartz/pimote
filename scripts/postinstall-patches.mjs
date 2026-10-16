#!/usr/bin/env node

import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pathParts = packageRoot.split('/node_modules/');
const isInstalledPackage = pathParts.length > 1;
const installRoot = isInstalledPackage ? pathParts[0] : packageRoot;
const patchDir = join(packageRoot, 'patches');

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

async function readBundledDependencies() {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    return new Set(Array.isArray(bundled) ? bundled : []);
  } catch {
    return new Set();
  }
}

/**
 * A published package must patch only dependencies it carries in its own
 * bundle. A source checkout may patch its workspace dependencies for builds.
 */
async function checkPatchTargets(
  patchFiles,
  { packageRoot: targetRoot = packageRoot, isInstalledPackage: targetIsInstalledPackage = isInstalledPackage, bundledDependencies = new Set() } = {},
) {
  const mismatches = [];
  const applicable = [];
  for (const fileName of patchFiles) {
    const { name, version } = parsePatchFilename(fileName);
    if (targetIsInstalledPackage && !bundledDependencies.has(name)) {
      console.log(`[pimote] ${fileName}: ${name} is not bundled with Pimote; skipping`);
      continue;
    }

    const installed = await readInstalledVersion(name, targetRoot);
    if (installed === undefined) {
      console.log(`[pimote] ${fileName}: ${name} is not installed here; skipping`);
      continue;
    }
    if (installed !== version) {
      mismatches.push(`[pimote] ${fileName}: patch targets ${name}@${version}, but installed version is ${installed}`);
      continue;
    }
    applicable.push(fileName);
  }
  return { mismatches, applicable };
}

async function readInstalledVersion(name, targetRoot = packageRoot) {
  // Never fall back to the consumer's node_modules. That tree can contain a
  // different package that Pimote does not own.
  const manifestPath = join(targetRoot, 'node_modules', name, 'package.json');
  try {
    const manifest = await readFile(manifestPath, 'utf8');
    return JSON.parse(manifest).version;
  } catch {
    return undefined;
  }
}

async function findPatchPackageEntrypoint(targetRoot = packageRoot, targetInstallRoot = installRoot) {
  const candidates = [join(targetRoot, 'node_modules', 'patch-package', 'index.js'), join(targetInstallRoot, 'node_modules', 'patch-package', 'index.js')];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
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

  const bundledDependencies = await readBundledDependencies();
  const { mismatches, applicable } = await checkPatchTargets(patchFiles, {
    packageRoot,
    isInstalledPackage,
    bundledDependencies,
  });
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) {
      console.error(mismatch);
    }
    console.error('[pimote] Regenerate stale patches: edit node_modules, then run `npx patch-package <pkg> --patch-dir patches`.');
    process.exit(1);
  }

  if (applicable.length === 0) {
    console.log('[pimote] no patch targets installed here; nothing to apply');
    return;
  }

  const patchPackageEntrypoint = await findPatchPackageEntrypoint(packageRoot, installRoot);
  if (!patchPackageEntrypoint) {
    throw new Error(`[pimote] Could not find patch-package for ${packageRoot}`);
  }

  // patch-package applies every file in --patch-dir and exits non-zero on CI
  // when a file names a missing package. Hand it only the applicable patches,
  // copied into a temp dir inside Pimote's package root.
  const filteredDir = await mkdtemp(join(packageRoot, '.pimote-patches-'));
  try {
    for (const fileName of applicable) {
      await copyFile(join(patchDir, fileName), join(filteredDir, fileName));
    }
    const result = spawnSync(process.execPath, [patchPackageEntrypoint, '--patch-dir', basename(filteredDir)], {
      cwd: packageRoot,
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    await rm(filteredDir, { recursive: true, force: true });
  }
}

export { checkPatchTargets, parsePatchFilename, readInstalledVersion };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
