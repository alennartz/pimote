// Guardrail: component and route source must not contain raw color literals.
// Every color lives in routes/layout.css as a token (surface ladder, callout
// families, status colors); components reference them with var() and derive
// hover/alpha variants with color-mix(). Keeping literals out keeps the main
// surface and callout palette in one place when themes change.
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

const PIMOTE_THEME_TOKENS = [
  '--status-active',
  '--status-streaming',
  '--status-streaming-on-primary',
  '--status-connected',
  '--status-error',
  '--status-reconnecting',
  '--status-reconnecting-on-primary',
  '--surface-sunken',
  '--surface-raised',
  '--surface-subtle',
  '--surface-hover',
  '--error-accent',
  '--error-surface',
  '--error-foreground',
  '--error-avatar-fg',
  '--skill-accent',
  '--skill-surface',
  '--skill-foreground',
  '--skill-foreground-hover',
  '--bash-accent',
  '--custom-accent',
  '--custom-surface',
  '--custom-foreground',
  '--custom-foreground-hover',
  '--link',
  '--link-hover',
  '--avatar-bg',
  '--avatar-fg',
  '--shadow-color',
] as const;

function declaredTokens(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((match) => match[1]));
}

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

  it('defines every Pimote semantic token in both palettes', () => {
    const css = readFileSync(join(SRC_ROOT, 'routes/layout.css'), 'utf8');
    const rootBlock = css.match(/:root \{([\s\S]*?)\n\}\n\n\.dark \{/i)?.[1] ?? '';
    const darkBlock = css.match(/\.dark \{([\s\S]*?)\n\}\n\n@theme inline/i)?.[1] ?? '';
    const missingFromRoot = PIMOTE_THEME_TOKENS.filter((token) => !declaredTokens(rootBlock).has(token));
    const missingFromDark = PIMOTE_THEME_TOKENS.filter((token) => !declaredTokens(darkBlock).has(token));

    expect({ missingFromRoot, missingFromDark }).toEqual({ missingFromRoot: [], missingFromDark: [] });
  });
});
