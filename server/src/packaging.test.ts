import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `make deploy` packs the *root* @pimote/pimote package and installs it
// standalone. Only the root package.json `dependencies` are installed, so any
// bare import reachable from server runtime code must be declared there.
// Workspace-hoisted deps in dev mask missing entries — this test can't.

const serverSrcDir = join(dirname(fileURLToPath(import.meta.url)));

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

function runtimeBareImports(source: string): string[] {
  // Type-only imports/re-exports are erased at compile time and create no
  // runtime dependency.
  const runtime = source.replace(/(import|export)\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
  const specifiers = new Set<string>();
  for (const match of runtime.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    specifiers.add(match[1]);
  }
  for (const match of runtime.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of runtime.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('@pimote/') && spec !== 'vitest');
}

describe('packed root package declares all server runtime dependencies', () => {
  it('every bare import in server/src is in the root package.json dependencies', async () => {
    const rootPackageJson = JSON.parse(await readFile(join(serverSrcDir, '..', '..', 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
    const declared = new Set(Object.keys(rootPackageJson.dependencies));

    const files = await listSourceFiles(serverSrcDir);
    expect(files.length).toBeGreaterThan(0);

    const undeclared = new Map<string, string[]>();
    for (const file of files) {
      const source = await readFile(file, 'utf-8');
      for (const spec of runtimeBareImports(source)) {
        if (!declared.has(spec)) {
          const relative = file.slice(serverSrcDir.length + 1);
          const list = undeclared.get(spec) ?? [];
          list.push(relative);
          undeclared.set(spec, list);
        }
      }
    }

    expect([...undeclared.entries()].map(([spec, files]) => `${spec} (${files.join(', ')})`)).toEqual([]);
  });
});
