#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readlink, realpath, rename, rm, symlink, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const deployRoot = process.env.PIMOTE_INSTALL_ROOT || join(homedir(), '.local', 'share', 'pimote');
const releasesDir = join(deployRoot, 'releases');
const currentLink = join(deployRoot, 'current');
const keepReleases = Number.parseInt(process.env.PIMOTE_KEEP_RELEASES || '3', 10);

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertBuiltArtifacts() {
  const required = [join(repoRoot, 'client', 'build', 'index.html'), join(repoRoot, 'server', 'dist', 'cli.js')];

  for (const path of required) {
    if (!(await pathExists(path))) {
      throw new Error(`[pimote] Missing build artifact: ${path}\nRun \`npm run build\` first.`);
    }
  }
}

function runJson(command, args, cwd) {
  const raw = execFileSync(command, args, { cwd, encoding: 'utf-8' });
  return JSON.parse(raw);
}

function runInherit(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function updateCurrentSymlink(target) {
  const tempLink = join(deployRoot, '.current.tmp');
  await rm(tempLink, { recursive: true, force: true });
  await symlink(target, tempLink);
  try {
    await rename(tempLink, currentLink);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      await rm(currentLink, { recursive: true, force: true });
      await rename(tempLink, currentLink);
      return;
    }
    throw err;
  }
}

async function pruneOldReleases() {
  if (!Number.isInteger(keepReleases) || keepReleases < 1) return;

  const currentTarget = await realpath(currentLink).catch(() => null);
  const entries = await readdir(releasesDir, { withFileTypes: true });
  const releases = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releasesDir, entry.name))
    .sort()
    .reverse();

  let kept = 0;
  for (const releasePath of releases) {
    const resolved = await realpath(releasePath).catch(() => releasePath);
    if (currentTarget && resolved === currentTarget) {
      kept += 1;
      continue;
    }
    if (kept < keepReleases) {
      kept += 1;
      continue;
    }
    await rm(releasePath, { recursive: true, force: true });
  }
}

async function main() {
  await assertBuiltArtifacts();
  await mkdir(releasesDir, { recursive: true });

  const packInfo = runJson('npm', ['pack', '--ignore-scripts', '--json'], repoRoot);
  if (!Array.isArray(packInfo) || packInfo.length === 0) {
    throw new Error('[pimote] npm pack did not return any package metadata.');
  }

  const tarballFilename = packInfo[0].filename;
  const packageName = packInfo[0].name;
  const version = packInfo[0].version;
  const tarballPath = join(repoRoot, tarballFilename);
  const releaseDir = join(releasesDir, `${timestamp()}-v${version}`);
  const releasePackageRoot = join(releaseDir, 'node_modules', ...String(packageName).split('/'));

  try {
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, 'package.json'), JSON.stringify({ name: 'pimote-local-install', private: true }, null, 2) + '\n', 'utf-8');

    console.log(`[pimote] Installing ${tarballFilename} into ${releaseDir}`);
    runInherit('npm', ['install', '--omit=dev', '--no-save', '--package-lock=false', tarballPath], releaseDir);

    if (!(await pathExists(join(releasePackageRoot, 'bin', 'pimote.js')))) {
      throw new Error(`[pimote] Installed package is missing ${join(releasePackageRoot, 'bin', 'pimote.js')}`);
    }

    await updateCurrentSymlink(releaseDir);
    await pruneOldReleases();

    const currentTarget = await readlink(currentLink).catch(() => releaseDir);
    console.log(`[pimote] Installed release: ${releaseDir}`);
    console.log(`[pimote] Current symlink: ${currentLink} -> ${currentTarget}`);
    console.log(`[pimote] Package root: ${releasePackageRoot}`);
  } finally {
    await rm(tarballPath, { force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
