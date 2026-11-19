import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTheme } from '@pimote/shared';
import { ThemeBridge, themeCacheKey, type ThemeBridgeOptions } from './theme-bridge.js';

function theme(): ResolvedTheme {
  return { id: 'pimote/dark', name: 'Pimote Dark', source: 'builtin', colorScheme: 'dark', ui: {}, editor: { surface: {}, syntax: {}, terminal: {} } } as ResolvedTheme;
}

function options(overrides: Partial<ThemeBridgeOptions> = {}): ThemeBridgeOptions {
  const values = new Map<string, string>();
  return {
    user: 'alice',
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    target: {
      root: { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn() } } as unknown as HTMLElement,
      themeColorMeta: { content: '#ffffff' } as HTMLMetaElement,
    },
    ...overrides,
  };
}

describe('ThemeBridge', () => {
  it('uses distinct non-empty cache keys for different Pimote users', () => {
    const aliceKey = themeCacheKey('alice');
    const bobKey = themeCacheKey('bob');
    expect(aliceKey).not.toBe('');
    expect(bobKey).not.toBe('');
    expect(bobKey).not.toBe(aliceKey);
  });

  it('applies a cached resolved theme before a static report renders', () => {
    const config = options();
    config.storage.setItem(themeCacheKey('alice'), JSON.stringify(theme()));
    const bridge = new ThemeBridge(config);

    expect(bridge.start()).toMatchObject({ id: 'pimote/dark' });
  });

  it('leaves report fallback styles untouched when no cache exists', () => {
    const config = options();
    const bridge = new ThemeBridge(config);

    expect(bridge.start()).toBeNull();
  });

  it('applies cross-tab storage updates and stops listening on teardown', () => {
    const listeners = new Map<string, (event: StorageEvent) => void>();
    const eventSource = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => listeners.set(type, listener as (event: StorageEvent) => void),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Window;
    const bridge = new ThemeBridge(options({ eventSource }));

    bridge.start();
    listeners.get('storage')?.({ key: themeCacheKey('alice'), newValue: JSON.stringify(theme()) } as StorageEvent);
    bridge.stop();

    expect(listeners.has('storage')).toBe(false);
  });
});
