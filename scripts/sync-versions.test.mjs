import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncedWorkspaces, syncVersions } from './sync-versions.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

async function writeManifest(root, workspace, manifest) {
  await mkdir(join(root, workspace), { recursive: true });
  await writeFile(join(root, workspace, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'pimote-versions-'));
  try {
    await writeManifest(root, '.', { name: '@pimote/pimote', version: '2.0.0', scripts: { build: 'tsc' } });
    for (const workspace of syncedWorkspaces) {
      await writeManifest(root, workspace, { name: `@pimote/${workspace.split('/').at(-1)}`, version: '1.9.0' });
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('propagates the root version into every synced workspace', () =>
  withFixture(async (root) => {
    const results = await syncVersions(root);

    assert.deepEqual(results.map((row) => row.changed), [true, true, true]);
    for (const workspace of syncedWorkspaces) {
      const manifest = JSON.parse(await readFile(join(root, workspace, 'package.json'), 'utf8'));
      assert.equal(manifest.version, '2.0.0');
    }
  }));

test('keeps non-version fields and formatting intact', () =>
  withFixture(async (root) => {
    await syncVersions(root);

    const raw = await readFile(join(root, 'client', 'package.json'), 'utf8');
    const manifest = JSON.parse(raw);
    assert.equal(manifest.name, '@pimote/client');
    assert.match(raw, /\n$/);
    assert.match(raw, /^\{\n  "/);
  }));

test('is idempotent once workspaces match the root version', () =>
  withFixture(async (root) => {
    await syncVersions(root);
    const results = await syncVersions(root);

    assert.deepEqual(results.filter((row) => row.changed), []);
  }));

test('repo manifests declare the root version', async () => {
  const root = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const workspace of syncedWorkspaces) {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, workspace, 'package.json'), 'utf8'));
    assert.equal(
      manifest.version,
      root.version,
      `${workspace} version ${manifest.version} drifted from the root version ${root.version}; run "npm version <v>" at the repo root instead of bumping workspaces individually.`,
    );
  }
});
