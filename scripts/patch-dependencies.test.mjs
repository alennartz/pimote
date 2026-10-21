import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkPatchTargets, parsePatchFilename } from './patch-dependencies.mjs';

async function writeVersion(packageRoot, packageName, version) {
  const packagePath = join(packageRoot, 'node_modules', ...packageName.split('/'));
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: packageName, version }));
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'pimote-patch-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parsePatchFilename parses scoped package targets', () => {
  assert.deepEqual(parsePatchFilename('@scope+package+1.2.3.patch'), {
    name: '@scope/package',
    version: '1.2.3',
  });
});

test('checks installed dependency versions before patching', () =>
  withFixture(async (packageRoot) => {
    await writeVersion(packageRoot, '@earendil-works/pi-coding-agent', '1.3.0');

    const result = await checkPatchTargets(['@earendil-works+pi-coding-agent+1.3.0.patch'], { packageRoot });

    assert.deepEqual(result, {
      missing: [],
      mismatches: [],
      applicable: ['@earendil-works+pi-coding-agent+1.3.0.patch'],
    });
  }));

test('reports a missing required target', () =>
  withFixture(async (packageRoot) => {
    const result = await checkPatchTargets(['streaming-markdown+0.2.15.patch'], { packageRoot });

    assert.deepEqual(result, {
      missing: ['[pimote] streaming-markdown+0.2.15.patch: streaming-markdown@0.2.15 is not installed'],
      mismatches: [],
      applicable: [],
    });
  }));

test('reports a stale patch target before mutation', () =>
  withFixture(async (packageRoot) => {
    await writeVersion(packageRoot, '@earendil-works/pi-coding-agent', '1.2.0');

    const result = await checkPatchTargets(['@earendil-works+pi-coding-agent+1.3.0.patch'], { packageRoot });

    assert.deepEqual(result, {
      missing: [],
      mismatches: ['[pimote] @earendil-works+pi-coding-agent+1.3.0.patch: patch targets @earendil-works/pi-coding-agent@1.3.0, but installed version is 1.2.0'],
      applicable: [],
    });
  }));
