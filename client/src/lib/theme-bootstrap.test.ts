// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../../shared/test/theme-fixtures.js';
import { bootstrapCachedTheme } from './theme-bootstrap.js';
import { themeCacheKey } from './theme-bridge.js';

describe('bootstrapCachedTheme', () => {
  it('applies the matching user-scoped cached palette', () => {
    const theme = resolvedTheme('pimote/dark');
    theme.ui.background = '#123456';
    const values = new Map([[themeCacheKey('alice'), JSON.stringify(theme)]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const root = document.createElement('div');

    expect(bootstrapCachedTheme('alice', storage, { root })).toMatchObject({ id: 'pimote/dark' });
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');

    const otherRoot = document.createElement('div');
    expect(bootstrapCachedTheme('bob', storage, { root: otherRoot })).toBeNull();
    expect(otherRoot.style.getPropertyValue('--pimote-ui-background')).toBe('');
  });

  it.each([null, '{broken'])('leaves fallback styles untouched for absent or invalid cache', (cached) => {
    const storage = { getItem: () => cached, setItem: () => {} };
    const root = document.createElement('div');
    root.style.setProperty('--pimote-ui-background', '#abcdef');

    expect(bootstrapCachedTheme('alice', storage, { root })).toBeNull();
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#abcdef');
  });
});
