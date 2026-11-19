// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../../shared/test/theme-fixtures.js';
import { applyResolvedTheme } from './theme-application.js';

describe('applyResolvedTheme', () => {
  it('applies the UI, editor, and terminal palette to the root', () => {
    const root = document.createElement('div');
    const theme = resolvedTheme('publisher/theme');
    theme.ui.background = '#123456';
    theme.editor.surface.background = '#234567';
    theme.editor.syntax.keyword = '#345678';
    theme.editor.terminal.black = '#456789';

    applyResolvedTheme(theme, { root });

    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');
    expect(root.style.getPropertyValue('--pimote-editor-background')).toBe('#234567');
    expect(root.style.getPropertyValue('--pimote-editor-keyword')).toBe('#345678');
    expect(root.style.getPropertyValue('--pimote-terminal-black')).toBe('#456789');
  });

  it('updates the root mode and browser metadata when themes change', () => {
    const root = document.createElement('div');
    const meta = document.createElement('meta');
    const dark = resolvedTheme('publisher/dark');
    for (const token of Object.keys(dark.ui) as Array<keyof typeof dark.ui>) dark.ui[token] = '#123456';
    const light = resolvedTheme('publisher/light');
    for (const token of Object.keys(light.ui) as Array<keyof typeof light.ui>) light.ui[token] = '#abcdef';

    applyResolvedTheme(dark, { root, themeColorMeta: meta });
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark');
    expect(meta.content).toBe('#123456');

    applyResolvedTheme(light, { root, themeColorMeta: meta });
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.getPropertyValue('color-scheme')).toBe('light');
    expect(meta.content).toBe('#abcdef');
  });
});
