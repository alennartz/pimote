import { ANSI_COLOR_NAMES, EDITOR_SURFACE_ROLES, SYNTAX_SCOPES, UI_COLOR_TOKENS, editorPropertyName, type ResolvedTheme } from '@pimote/shared';
import type { ThemeApplicationTarget } from './theme-application.js';
import { applyResolvedTheme } from './theme-application.js';

/** Options for the same-origin static-report theme bridge. */
export interface ThemeBridgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeBridgeOptions {
  user: string;
  storage: ThemeBridgeStorage;
  target: ThemeApplicationTarget;
  /** Event source used for cross-tab storage updates. */
  eventSource?: Window;
}

const UI_KEYS = UI_COLOR_TOKENS;
const SURFACE_KEYS = EDITOR_SURFACE_ROLES;
const SYNTAX_KEYS = SYNTAX_SCOPES;
const TERMINAL_KEYS = ANSI_COLOR_NAMES;

function completeMap(value: unknown, keys: readonly string[]): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  return keys.every((key) => typeof map[key] === 'string' && map[key].length > 0);
}

function normalizeCachedTheme(value: unknown): ResolvedTheme | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.name !== 'string' || !candidate.name) return null;
  if (candidate.source !== 'builtin' && candidate.source !== 'extension' && candidate.source !== 'user') return null;
  if (candidate.colorScheme !== 'light' && candidate.colorScheme !== 'dark') return null;
  if (!candidate.editor || typeof candidate.editor !== 'object' || Array.isArray(candidate.editor)) return null;
  const editor = candidate.editor as Record<string, unknown>;
  if (!completeMap(candidate.ui, UI_KEYS)) return null;
  if (!completeMap(editor.surface, SURFACE_KEYS) || !completeMap(editor.syntax, SYNTAX_KEYS) || !completeMap(editor.terminal, TERMINAL_KEYS)) return null;
  return candidate as unknown as ResolvedTheme;
}

const cacheProperties = [
  ...UI_KEYS.map((key) => `--pimote-ui-${key}`),
  ...SURFACE_KEYS.map((key) => `--pimote-editor-${key}`),
  ...SYNTAX_KEYS.map((scope) => editorPropertyName(scope)),
  ...TERMINAL_KEYS.map((key) => `--pimote-terminal-${key}`),
];

interface CapturedFallback {
  styles: ReadonlyArray<readonly [string, string, string]>;
  dark: boolean;
  colorScheme: string;
  themeColor: string | null;
}

function captureFallback(target: ThemeApplicationTarget): CapturedFallback {
  const styles = cacheProperties.map((property) => [property, target.root.style.getPropertyValue(property), target.root.style.getPropertyPriority(property)] as const);
  const meta = target.themeColorMeta ?? target.root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  return {
    styles,
    dark: target.root.classList.contains('dark'),
    colorScheme: target.root.style.getPropertyValue('color-scheme'),
    themeColor: meta?.getAttribute('content') ?? null,
  };
}

function restoreFallback(target: ThemeApplicationTarget, fallback: CapturedFallback): void {
  for (const [property, value, priority] of fallback.styles) {
    if (value) target.root.style.setProperty(property, value, priority);
    else target.root.style.removeProperty(property);
  }
  target.root.classList.toggle('dark', fallback.dark);
  if (fallback.colorScheme) target.root.style.setProperty('color-scheme', fallback.colorScheme);
  else target.root.style.removeProperty('color-scheme');
  const meta = target.themeColorMeta ?? target.root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    if (fallback.themeColor === null) meta.removeAttribute('content');
    else meta.setAttribute('content', fallback.themeColor);
  }
}

/** Read one valid, complete cached theme without allowing storage failures out. */
export function readCachedTheme(user: string, storage: ThemeBridgeStorage): ResolvedTheme | null {
  try {
    const raw = storage.getItem(themeCacheKey(user));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return normalizeCachedTheme(parsed);
  } catch {
    return null;
  }
}

/** Public lifecycle for reports that opt into the shared PWA palette. */
export class ThemeBridge {
  private listening = false;
  private readonly fallback: CapturedFallback;
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== themeCacheKey(this.options.user)) return;
    this.apply(event.newValue ? parseTheme(event.newValue) : null);
  };

  constructor(private readonly options: ThemeBridgeOptions) {
    this.fallback = captureFallback(options.target);
  }

  /** Read and apply the user-scoped cached resolved theme, if present. */
  start(): ResolvedTheme | null {
    const theme = readCachedTheme(this.options.user, this.options.storage);
    this.apply(theme);
    if (!this.listening && this.options.eventSource) {
      this.options.eventSource.addEventListener('storage', this.onStorage);
      this.listening = true;
    }
    return theme;
  }

  /** Stop listening for cross-tab cache updates. */
  stop(): void {
    if (!this.listening || !this.options.eventSource) return;
    this.options.eventSource.removeEventListener('storage', this.onStorage);
    this.listening = false;
  }

  /** Apply one cache update received from another tab. */
  apply(theme: ResolvedTheme | null): void {
    if (theme) applyResolvedTheme(theme, this.options.target);
    else restoreFallback(this.options.target, this.fallback);
  }
}

function parseTheme(raw: string): ResolvedTheme | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeCachedTheme(parsed);
  } catch {
    return null;
  }
}

/** Start the browser entry point used by static reports. Returns a cleanup function. */
export function startReportThemeBridge(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return () => {};
  }
  const root = document.documentElement;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  let user = readUser(storage);
  let bridge = new ThemeBridge({ user, storage, target: { root, themeColorMeta: meta }, eventSource: window });
  bridge.start();
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== 'pimote:user') return;
    const nextUser = event.newValue?.trim() || 'default';
    if (nextUser === user) return;
    bridge.stop();
    bridge.apply(null);
    user = nextUser;
    bridge = new ThemeBridge({ user, storage, target: { root, themeColorMeta: meta }, eventSource: window });
    bridge.start();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    bridge.stop();
    window.removeEventListener('storage', onStorage);
  };
}

function readUser(storage: Pick<Storage, 'getItem'>): string {
  try {
    return storage.getItem('pimote:user')?.trim() || 'default';
  } catch {
    return 'default';
  }
}

/** Stable cache key shared by the PWA and static reports. */
export function themeCacheKey(user: string): string {
  return `pimote:theme:${encodeURIComponent(user || 'default')}`;
}
