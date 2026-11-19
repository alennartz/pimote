import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTheme } from '@pimote/shared';
import { bootstrapCachedTheme } from './theme-bootstrap.js';
import { themeCacheKey } from './theme-bridge.js';

function theme(): ResolvedTheme {
  return { id: 'pimote/dark', name: 'Pimote Dark', source: 'builtin', colorScheme: 'dark', ui: {}, editor: { surface: {}, syntax: {}, terminal: {} } } as ResolvedTheme;
}

function target() {
  return {
    root: { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn() } } as unknown as HTMLElement,
    themeColorMeta: { content: '#ffffff' } as HTMLMetaElement,
  };
}

describe('bootstrapCachedTheme', () => {
  it('applies a user-scoped cached theme before the PWA renders', () => {
    const values = new Map([[themeCacheKey('alice'), JSON.stringify(theme())]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn() };

    expect(bootstrapCachedTheme('alice', storage, target())).toMatchObject({ id: 'pimote/dark' });
  });

  it('does not override fallback styles when the cache is absent or invalid', () => {
    const storage = { getItem: () => '{broken', setItem: vi.fn() };

    expect(bootstrapCachedTheme('alice', storage, target())).toBeNull();
  });
});
