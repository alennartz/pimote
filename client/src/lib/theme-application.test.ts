import { describe, expect, it } from 'vitest';
import type { ResolvedTheme } from '@pimote/shared';
import { applyResolvedTheme, type ThemeApplicationTarget } from './theme-application.js';

function theme(colorScheme: 'light' | 'dark' = 'dark'): ResolvedTheme {
  return { id: 'publisher/theme', name: 'Publisher Theme', source: 'extension', colorScheme, ui: {}, editor: { surface: {}, syntax: {}, terminal: {} } } as ResolvedTheme;
}

function target(): ThemeApplicationTarget {
  return {
    root: {
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      style: { setProperty: () => {} },
    } as unknown as HTMLElement,
    themeColorMeta: { content: '#ffffff' } as HTMLMetaElement,
  };
}

describe('applyResolvedTheme', () => {
  it('writes UI, editor, and terminal custom properties to the root', () => {
    const properties = new Map<string, string>();
    const root = {
      classList: { toggle: () => {} },
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    } as unknown as HTMLElement;

    applyResolvedTheme(theme(), { root, themeColorMeta: { content: '#ffffff' } as HTMLMetaElement });

    expect(properties.get('--pimote-ui-background')).toBeDefined();
    expect(properties.get('--pimote-editor-background')).toBeDefined();
    expect(properties.get('--pimote-terminal-black')).toBeDefined();
  });

  it('sets dark mode, color-scheme, and browser theme-color metadata from the palette', () => {
    let dark = false;
    const root = {
      classList: { toggle: (_name: string, enabled: boolean) => (dark = enabled) },
      style: { setProperty: () => {} },
    } as unknown as HTMLElement;
    const meta = { content: '#ffffff' } as HTMLMetaElement;

    applyResolvedTheme(theme('dark'), { root, themeColorMeta: meta });

    expect(dark).toBe(true);
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark');
    expect(meta.content).not.toBe('#ffffff');
  });

  it('does not change the installation manifest color fallback', () => {
    const meta = { content: '#ffffff' } as HTMLMetaElement;
    applyResolvedTheme(theme('light'), target());
    expect(meta.content).toBe('#ffffff');
  });
});
