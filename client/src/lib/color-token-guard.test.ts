// Guardrail: component and route source must not contain raw color literals.
// Every color lives in routes/layout.css as a token (surface ladder, callout
// families, status colors); components reference them with var() and derive
// hover/alpha variants with color-mix(). Keeping literals out is what makes a
// future light theme a tokens-only change.
//
// Allowlist:
// - routes/layout.css: the token source of truth.
// - lib/highlight-theme.css: vendored syntax theme, swapped wholesale later.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const ALLOWLIST = new Set(['routes/layout.css', 'lib/highlight-theme.css']);

const RAW_COLOR = /oklch\(|#[0-9a-fA-F]{3,8}\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (/\.(svelte|ts|css)$/.test(entry.name) && !entry.name.includes('.test.')) {
      const rel = relative(SRC_ROOT, abs).split(sep).join('/');
      if (!ALLOWLIST.has(rel)) out.push(rel);
    }
  }
  return out;
}

describe('color token guardrail', () => {
  it('finds no raw oklch()/hex literals outside the allowlist', () => {
    const offenders = walk(SRC_ROOT)
      .filter((rel) => RAW_COLOR.test(readFileSync(join(SRC_ROOT, rel), 'utf8')))
      .sort();

    expect(offenders, 'Raw color literals belong in routes/layout.css tokens — see the token blocks there.').toEqual([]);
  });
});
