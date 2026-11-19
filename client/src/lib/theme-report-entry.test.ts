// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvedTheme } from '../../../shared/test/theme-fixtures.js';
import { startReportThemeBridge, themeCacheKey } from './theme-bridge.js';

let frame: HTMLIFrameElement;
let page: Window & typeof globalThis;
let stop: (() => void) | undefined;

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  page = frame.contentWindow! as Window & typeof globalThis;
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', page.document);
  vi.stubGlobal('localStorage', page.localStorage);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  page.localStorage.clear();
  vi.unstubAllGlobals();
  frame.remove();
});

function cachedTheme(id: string, background: string) {
  const theme = resolvedTheme(id);
  theme.ui.background = background;
  theme.editor.surface.background = '#234567';
  theme.editor.syntax.keyword = '#345678';
  theme.editor.terminal.black = '#456789';
  return JSON.stringify(theme);
}

describe('report theme bridge entry', () => {
  it('discovers the Pimote user and applies that user’s cached paired palette', () => {
    page.localStorage.setItem('pimote:user', 'alice');
    page.localStorage.setItem(themeCacheKey('alice'), cachedTheme('alice/theme', '#123456'));
    page.localStorage.setItem(themeCacheKey('bob'), cachedTheme('bob/theme', '#abcdef'));

    stop = startReportThemeBridge();

    const root = page.document.documentElement;
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#123456');
    expect(root.style.getPropertyValue('--pimote-editor-background')).toBe('#234567');
    expect(root.style.getPropertyValue('--pimote-editor-keyword')).toBe('#345678');
    expect(root.style.getPropertyValue('--pimote-terminal-black')).toBe('#456789');
  });

  it('leaves report fallback styles untouched when the current user has no cached theme', () => {
    page.localStorage.setItem('pimote:user', 'alice');
    const root = page.document.documentElement;
    root.style.setProperty('--pimote-ui-background', '#abcdef');
    root.style.setProperty('--pimote-editor-background', '#fedcba');

    stop = startReportThemeBridge();

    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#abcdef');
    expect(root.style.getPropertyValue('--pimote-editor-background')).toBe('#fedcba');
  });

  it('updates for the current user and follows user changes across tabs', () => {
    const aliceKey = themeCacheKey('alice');
    const bobKey = themeCacheKey('bob');
    page.localStorage.setItem('pimote:user', 'alice');
    page.localStorage.setItem(aliceKey, cachedTheme('alice/theme', '#123456'));
    page.localStorage.setItem(bobKey, cachedTheme('bob/theme', '#abcdef'));
    stop = startReportThemeBridge();

    const root = page.document.documentElement;
    const changed = cachedTheme('alice/new', '#654321');
    page.localStorage.setItem(aliceKey, changed);
    page.dispatchEvent(new page.StorageEvent('storage', { key: aliceKey, newValue: changed, storageArea: page.localStorage }));
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#654321');

    page.localStorage.setItem('pimote:user', 'bob');
    page.dispatchEvent(new page.StorageEvent('storage', { key: 'pimote:user', oldValue: 'alice', newValue: 'bob', storageArea: page.localStorage }));
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#abcdef');

    page.localStorage.setItem(aliceKey, changed);
    page.dispatchEvent(new page.StorageEvent('storage', { key: aliceKey, newValue: changed, storageArea: page.localStorage }));
    expect(root.style.getPropertyValue('--pimote-ui-background')).toBe('#abcdef');
  });
});
