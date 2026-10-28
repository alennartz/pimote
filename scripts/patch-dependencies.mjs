#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const patchDir = join(packageRoot, 'patches');

async function listPatchFiles(dir = patchDir) {
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

async function readInstalledVersion(name, targetRoot = packageRoot) {
  const manifestPath = join(targetRoot, 'node_modules', name, 'package.json');
  try {
    const manifest = await readFile(manifestPath, 'utf8');
    return JSON.parse(manifest).version;
  } catch {
    return undefined;
  }
}

async function checkPatchTargets(patchFiles, { packageRoot: targetRoot = packageRoot } = {}) {
  const missing = [];
  const mismatches = [];
  const applicable = [];

  for (const fileName of patchFiles) {
    const { name, version } = parsePatchFilename(fileName);
    const installed = await readInstalledVersion(name, targetRoot);
    if (installed === undefined) {
      missing.push(`[pimote] ${fileName}: ${name}@${version} is not installed`);
      continue;
    }
    if (installed !== version) {
      mismatches.push(`[pimote] ${fileName}: patch targets ${name}@${version}, but installed version is ${installed}`);
      continue;
    }
    applicable.push(fileName);
  }

  return { missing, mismatches, applicable };
}

function runGit(args, { stdio = 'ignore' } = {}) {
  const result = spawnSync('git', args, {
    cwd: packageRoot,
    stdio,
  });
  if (result.error) {
    throw new Error(`[pimote] Could not run git while applying dependency patches: ${result.error.message}`);
  }
  return result.status === 0;
}

function patchPath(fileName) {
  return join(patchDir, fileName);
}

function patchStatus(fileName) {
  const path = patchPath(fileName);
  const applies = runGit(['apply', '--check', '--whitespace=nowarn', path]);
  const isApplied = runGit(['apply', '--reverse', '--check', '--whitespace=nowarn', path]);

  if (applies === isApplied) {
    throw new Error(`[pimote] ${fileName} is neither cleanly applicable nor cleanly applied`);
  }
  return applies ? 'pending' : 'applied';
}

function applyPatch(fileName) {
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', patchPath(fileName)], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`[pimote] Could not run git while applying ${fileName}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[pimote] Could not apply ${fileName}`);
  }
}

async function main() {
  const patchFiles = await listPatchFiles();
  if (patchFiles.length === 0) {
    return;
  }

  const { missing, mismatches, applicable } = await checkPatchTargets(patchFiles);
  if (missing.length > 0 || mismatches.length > 0) {
    for (const error of [...missing, ...mismatches]) {
      console.error(error);
    }
    console.error('[pimote] Dependency patches must target the installed package versions before building.');
    process.exitCode = 1;
    return;
  }

  const pending = [];
  for (const fileName of applicable) {
    if (patchStatus(fileName) === 'pending') {
      pending.push(fileName);
    }
  }

  for (const fileName of pending) {
    applyPatch(fileName);
    console.log(`[pimote] applied ${fileName}`);
  }

  if (pending.length === 0) {
    console.log('[pimote] dependency patches already applied');
  }
}

export { checkPatchTargets, listPatchFiles, parsePatchFilename, patchStatus, readInstalledVersion };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
