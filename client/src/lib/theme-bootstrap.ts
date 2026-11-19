import type { ResolvedTheme } from '@pimote/shared';
import type { ThemeApplicationTarget } from './theme-application.js';
import type { ThemeBridgeStorage } from './theme-bridge.js';

/** Apply a matching cached PWA theme before the application renders. */
export function bootstrapCachedTheme(_user: string, _storage: ThemeBridgeStorage, _target: ThemeApplicationTarget): ResolvedTheme | null {
  throw new Error('not implemented');
}
