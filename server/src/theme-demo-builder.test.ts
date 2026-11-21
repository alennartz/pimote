import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThemeDemoBuilder } from './theme-demo-builder.js';

function themeFile(): string {
  return `${JSON.stringify(
    {
      version: 1,
      themes: [
        {
          id: 'alice/custom',
          name: 'Alice Custom',
          colorScheme: 'dark',
          extends: 'pimote/dark',
          ui: { primary: '#ff00aa' },
          editor: { surface: {}, syntax: {}, terminal: {} },
        },
        {
          id: 'alice/broken',
          name: 'Broken',
          colorScheme: 'dark',
          extends: 'missing/base',
          ui: {},
          editor: { surface: {}, syntax: {}, terminal: {} },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

describe('ThemeDemoBuilder', () => {
  it('writes a stable bundle with every valid draft theme and catalog diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'theme-demo-builder-'));
    try {
      const source = join(root, 'draft.json');
      const outputRoot = join(root, 'bundles');
      await writeFile(source, themeFile(), 'utf8');

      const bundle = await new ThemeDemoBuilder({ outputRoot }).prepare(source);

      expect(bundle.themeIds).toEqual(['alice/custom']);
      expect(bundle.title).toBe('Theme demo: draft.json');
      expect(bundle.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ themeId: 'alice/broken', message: expect.stringMatching(/missing inheritance base/) })]),
      );
      await expect(readFile(join(bundle.folderPath, 'index.html'), 'utf8')).resolves.toContain('Theme demo');
      const payload = JSON.parse(await readFile(join(bundle.folderPath, 'themes.json'), 'utf8')) as {
        themes: Array<{ id: string }>;
        palettes: Record<string, Record<string, string>>;
        audit: { themeCount: number };
      };
      expect(payload.themes.map((theme) => theme.id)).toEqual(['alice/custom']);
      expect(payload.palettes['alice/custom']).toEqual({});
      expect(payload.audit.themeCount).toBe(1);

      const again = await new ThemeDemoBuilder({ outputRoot }).prepare(source);
      expect(again.folderPath).toBe(bundle.folderPath);

      await writeFile(source, '{not-json}\n', 'utf8');
      const invalid = await new ThemeDemoBuilder({ outputRoot }).prepare(source);
      expect(invalid.themeIds).toEqual([]);
      await expect(readFile(join(bundle.folderPath, 'themes.json'), 'utf8')).resolves.toContain('alice/custom');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
