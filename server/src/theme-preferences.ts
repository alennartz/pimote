import type { ResolvedTheme, ThemeCatalogSnapshot } from '../../shared/dist/index.js';

/** Persisted selection plus the resolved theme rendered by a connection. */
export interface ThemeSelection {
  selectedThemeId: string | null;
  activeThemeId: string;
  theme: ResolvedTheme;
}

export interface ThemeCatalogPort {
  snapshot(): ThemeCatalogSnapshot;
}

export interface ThemePreferencePort {
  selectedTheme(user: string): string | null;
  setSelectedTheme(user: string, themeId: string | null): Promise<boolean>;
}

export interface ThemePreferencesOptions {
  catalog: ThemeCatalogPort;
  profiles: ThemePreferencePort;
  lightFallbackId?: string;
}

/** Server command boundary for catalog reads and per-user theme selection. */
export class ThemePreferences {
  constructor(private readonly options: ThemePreferencesOptions) {}

  /** Return the current PWA-only catalog snapshot. */
  getCatalog(): ThemeCatalogSnapshot {
    throw new Error('not implemented');
  }

  /** Validate and persist a selection, or clear it with null. */
  async setTheme(_user: string, _themeId: string | null): Promise<ThemeSelection> {
    throw new Error('not implemented');
  }

  /** Resolve a saved selection against the current catalog and default. */
  resolve(_user: string): ThemeSelection {
    throw new Error('not implemented');
  }
}
