import type { ResolvedTheme } from '@pimote/shared';
import type { ThemeApplicationTarget } from './theme-application.js';
import { applyResolvedTheme } from './theme-application.js';
import { readCachedTheme, type ThemeBridgeStorage } from './theme-bridge.js';

/** Apply a matching cached PWA theme before the application renders. */
export function bootstrapCachedTheme(user: string, storage: ThemeBridgeStorage, target: ThemeApplicationTarget): ResolvedTheme | null {
  const theme = readCachedTheme(user, storage);
  if (theme) applyResolvedTheme(theme, target);
  return theme;
}
