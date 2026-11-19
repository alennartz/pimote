// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../../shared/test/theme-fixtures.js';
import { ThemeBridge, themeCacheKey, type ThemeBridgeOptions } from './theme-bridge.js';

function options(): ThemeBridgeOptions {
  const values = new Map<string, string>();
  return {
    user: 'alice',
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    target: { root: document.createElement('div') },
    eventSource: window,
  };
}

describe('ThemeBridge', () => {
  it('uses distinct cache keys for different Pimote users', () => {
    expect(themeCacheKey('alice')).not.toBe('');
    expect(themeCacheKey('bob')).not.toBe(themeCacheKey('alice'));
  });

  it('applies the user-scoped cached palette to a report', () => {
    const config = options();
    const theme = resolvedTheme('pimote/dark');
    theme.ui.background = '#123456';
    config.storage.setItem(themeCacheKey('alice'), JSON.stringify(theme));
    const bridge = new ThemeBridge(config);

    expect(bridge.start()).toMatchObject({ id: 'pimote/dark' });
    expect(config.target.root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');
    bridge.stop();
  });

  it('leaves report fallback styles untouched without a cache', () => {
    const config = options();
    config.target.root.style.setProperty('--pimote-ui-background', '#abcdef');
    const bridge = new ThemeBridge(config);

    expect(bridge.start()).toBeNull();
    expect(config.target.root.style.getPropertyValue('--pimote-ui-background')).toBe('#abcdef');
    bridge.stop();
  });

  it('applies cross-tab updates for the user and stops after teardown', () => {
    const config = options();
    const bridge = new ThemeBridge(config);
    const theme = resolvedTheme('pimote/dark');
    theme.ui.background = '#123456';
    bridge.start();

    const value = JSON.stringify(theme);
    config.storage.setItem(themeCacheKey('alice'), value);
    window.dispatchEvent(new StorageEvent('storage', { key: themeCacheKey('alice'), newValue: value }));
    expect(config.target.root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');

    bridge.stop();
    theme.ui.background = '#abcdef';
    const later = JSON.stringify(theme);
    config.storage.setItem(themeCacheKey('alice'), later);
    window.dispatchEvent(new StorageEvent('storage', { key: themeCacheKey('alice'), newValue: later }));
    expect(config.target.root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');
  });
});
