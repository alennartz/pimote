import type { ResolvedTheme } from '@pimote/shared';
import type { ThemeApplicationTarget } from './theme-application.js';

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

/** Public lifecycle for reports that opt into the shared PWA palette. */
export class ThemeBridge {
  constructor(private readonly options: ThemeBridgeOptions) {}

  /** Read and apply the user-scoped cached resolved theme, if present. */
  start(): ResolvedTheme | null {
    throw new Error('not implemented');
  }

  /** Stop listening for cross-tab cache updates. */
  stop(): void {
    throw new Error('not implemented');
  }

  /** Apply one cache update received from another tab. */
  apply(_theme: ResolvedTheme | null): void {
    throw new Error('not implemented');
  }
}

/** Stable cache key shared by the PWA and static reports. */
export function themeCacheKey(_user: string): string {
  throw new Error('not implemented');
}
