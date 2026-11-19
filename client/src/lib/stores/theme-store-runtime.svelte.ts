import { getUser } from './persistence.js';
import { connection } from './connection.svelte.js';
import { ThemeStore } from './theme-store.svelte.js';
import { applyResolvedTheme } from '../theme-application.js';

const storage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage is optional.
    }
  },
};

function currentUser(): string {
  return getUser() ?? 'default';
}

function createStore(user: string): ThemeStore {
  return new ThemeStore({
    user,
    send: (command) => connection.send(command),
    onEvent: (listener) => connection.onEvent(listener),
    storage,
    apply: (theme) => applyResolvedTheme(theme, { root: document.documentElement, themeColorMeta: document.querySelector('meta[name="theme-color"]') }),
  });
}

export const themeRuntime = $state<{ user: string; store: ThemeStore }>({ user: currentUser(), store: createStore(currentUser()) });
connection.onUserSessionsChanged = (event) => themeRuntime.store.handleProfile(event);

export function ensureThemeStoreUser(): ThemeStore {
  const user = currentUser();
  if (user !== themeRuntime.user) {
    themeRuntime.store.dispose();
    themeRuntime.user = user;
    themeRuntime.store = createStore(user);
  }
  return themeRuntime.store;
}

export function syncThemeConnection(): void {
  const store = ensureThemeStoreUser();
  store.sessionAdoptionComplete = connection.ready;
  if (connection.status === 'disconnected' || connection.status === 'reconnecting') store.resetConnection();
  if (!store.catalog && connection.status === 'connected') void store.loadCatalog().catch(() => {});
}
