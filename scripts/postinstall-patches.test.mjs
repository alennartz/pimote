import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkPatchTargets, parsePatchFilename } from './postinstall-patches.mjs';

async function writeVersion(packageRoot, packageName, version) {
  const packagePath = join(packageRoot, 'node_modules', ...packageName.split('/'));
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: packageName, version }));
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'pimote-postinstall-'));
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

test('checks the private package copy, not the consumer node_modules', () =>
  withFixture(async (consumerRoot) => {
    const packageRoot = join(consumerRoot, 'node_modules', '@pimote', 'pimote');
    await writeVersion(consumerRoot, '@earendil-works/pi-coding-agent', '1.2.0');
    await writeVersion(packageRoot, '@earendil-works/pi-coding-agent', '1.3.0');

    const result = await checkPatchTargets(['@earendil-works+pi-coding-agent+1.3.0.patch'], {
      packageRoot,
      isInstalledPackage: true,
      bundledDependencies: new Set(['@earendil-works/pi-coding-agent']),
    });

    assert.deepEqual(result, {
      mismatches: [],
      applicable: ['@earendil-works+pi-coding-agent+1.3.0.patch'],
    });
  }));

test('skips installed dependencies that are not bundled by Pimote', () =>
  withFixture(async (consumerRoot) => {
    const packageRoot = join(consumerRoot, 'node_modules', '@pimote', 'pimote');
    await writeVersion(packageRoot, 'streaming-markdown', '0.2.15');

    const result = await checkPatchTargets(['streaming-markdown+0.2.15.patch'], {
      packageRoot,
      isInstalledPackage: true,
      bundledDependencies: new Set(['@earendil-works/pi-coding-agent']),
    });

    assert.deepEqual(result, { mismatches: [], applicable: [] });
  }));

test('reports a stale patch for the private bundled copy', () =>
  withFixture(async (consumerRoot) => {
    const packageRoot = join(consumerRoot, 'node_modules', '@pimote', 'pimote');
    await writeVersion(packageRoot, '@earendil-works/pi-coding-agent', '1.2.0');

    const result = await checkPatchTargets(['@earendil-works+pi-coding-agent+1.3.0.patch'], {
      packageRoot,
      isInstalledPackage: true,
      bundledDependencies: new Set(['@earendil-works/pi-coding-agent']),
    });

    assert.deepEqual(result, {
      mismatches: ['[pimote] @earendil-works+pi-coding-agent+1.3.0.patch: patch targets @earendil-works/pi-coding-agent@1.3.0, but installed version is 1.2.0'],
      applicable: [],
    });
  }));
