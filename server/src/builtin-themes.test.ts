import Color from 'colorjs.io';
import { describe, expect, it } from 'vitest';
import { builtinThemeDefinitions } from './builtin-themes.js';

const DIFF_ROLES = ['inserted', 'deleted', 'changed'] as const;
const CALLOUT_FOREGROUNDS = [
  ['error-foreground', 'error-surface'],
  ['skill-foreground', 'skill-surface'],
  ['custom-foreground', 'custom-surface'],
] as const;

function contrast(foreground: string, background: string): number {
  return new Color(foreground).contrast(new Color(background), 'WCAG21');
}

describe('built-in theme mappings', () => {
  it('keeps every diff syntax role readable on editor and diff surfaces', () => {
    for (const theme of builtinThemeDefinitions()) {
      for (const role of DIFF_ROLES) {
        const foreground = theme.editor.syntax[role];
        expect(contrast(foreground, theme.editor.surface.background), `${theme.id} ${role} on editor background`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(foreground, theme.ui['surface-sunken']), `${theme.id} ${role} on diff surface`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses readable semantic foregrounds for muted labels and callout headers', () => {
    for (const theme of builtinThemeDefinitions()) {
      expect(contrast(theme.ui['muted-foreground'], theme.ui.muted), `${theme.id} muted label`).toBeGreaterThanOrEqual(3);
      for (const [foregroundRole, surfaceRole] of CALLOUT_FOREGROUNDS) {
        expect(contrast(theme.ui[foregroundRole], theme.ui[surfaceRole]), `${theme.id} ${foregroundRole}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
