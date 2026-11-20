import Color from 'colorjs.io';
import { describe, expect, it } from 'vitest';
import { builtinThemeDefinitions } from './builtin-themes.js';
import { ThemeCatalog } from './theme-catalog.js';

const DIFF_ROLES = ['inserted', 'deleted', 'changed'] as const;
const CALLOUT_FOREGROUNDS = [
  ['error-foreground', 'error-surface'],
  ['skill-foreground', 'skill-surface'],
  ['custom-foreground', 'custom-surface'],
] as const;

function opaque(value: string, backdrop: Color | string = '#000000'): Color {
  const color = new Color(value).to('srgb');
  const alpha = color.alpha ?? 1;
  if (alpha >= 1) return new Color('srgb', color.coords);
  const base = typeof backdrop === 'string' ? opaque(backdrop) : backdrop.to('srgb');
  return new Color(
    'srgb',
    color.coords.map((channel, index) => channel * alpha + base.coords[index] * (1 - alpha)),
  );
}

function contrast(foreground: string, background: string): number {
  const opaqueBackground = opaque(background);
  return opaque(foreground, opaqueBackground).contrast(opaqueBackground, 'WCAG21');
}

async function resolvedBuiltins() {
  const catalog = new ThemeCatalog({
    builtinThemes: builtinThemeDefinitions(),
    extensionFiles: [],
    userFile: '<empty>',
    defaultThemeId: 'pimote/light',
    reader: { read: async () => JSON.stringify({ version: 1, themes: [] }) },
  });
  const snapshot = await catalog.load();
  await catalog.close();
  return snapshot.themes;
}

describe('built-in theme mappings', () => {
  it('publishes every built-in color through a named palette reference', () => {
    for (const theme of builtinThemeDefinitions()) {
      expect(Object.keys(theme.palette ?? {}).length, theme.id).toBeGreaterThan(0);
      for (const value of [...Object.values(theme.ui), ...Object.values(theme.editor.surface), ...Object.values(theme.editor.syntax), ...Object.values(theme.editor.terminal)]) {
        expect(value, theme.id).toMatchObject({ palette: expect.any(String) });
      }
    }
  });

  it('keeps every diff syntax role readable on editor and diff surfaces', async () => {
    for (const theme of await resolvedBuiltins()) {
      for (const role of DIFF_ROLES) {
        const foreground = theme.editor.syntax[role];
        expect(contrast(foreground, theme.editor.surface.background), `${theme.id} ${role} on editor background`).toBeGreaterThanOrEqual(4.5);
        const diffBackground =
          role === 'inserted'
            ? theme.editor.surface['diff-addition-background']
            : role === 'deleted'
              ? theme.editor.surface['diff-deletion-background']
              : theme.editor.surface.background;
        expect(contrast(foreground, diffBackground), `${theme.id} ${role} on diff surface`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses readable semantic foregrounds for muted labels and callout headers', async () => {
    for (const theme of await resolvedBuiltins()) {
      expect(contrast(theme.ui['muted-foreground'], theme.ui.muted), `${theme.id} muted label`).toBeGreaterThanOrEqual(3);
      for (const [foregroundRole, surfaceRole] of CALLOUT_FOREGROUNDS) {
        expect(contrast(theme.ui[foregroundRole], theme.ui[surfaceRole]), `${theme.id} ${foregroundRole}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the selection foreground readable on the selection surface', async () => {
    for (const theme of await resolvedBuiltins()) {
      expect(contrast(theme.editor.surface['selection-foreground'], theme.editor.surface.selection), `${theme.id} selection`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
