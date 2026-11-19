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
  private readonly lightFallbackId: string;

  constructor(private readonly options: ThemePreferencesOptions) {
    this.lightFallbackId = options.lightFallbackId ?? 'pimote/light';
  }

  /** Return the current PWA-only catalog snapshot. */
  getCatalog(): ThemeCatalogSnapshot {
    return this.options.catalog.snapshot();
  }

  /** Validate and persist a selection, or clear it with null. */
  async setTheme(user: string, themeId: string | null): Promise<ThemeSelection> {
    if (themeId !== null && !this.getCatalog().themes.some((theme) => theme.id === themeId)) {
      throw new Error(`Unknown theme: ${themeId}`);
    }
    await this.options.profiles.setSelectedTheme(user, themeId);
    return this.resolve(user);
  }

  /** Resolve a saved selection against the current catalog and default. */
  resolve(user: string): ThemeSelection {
    const snapshot = this.getCatalog();
    const selectedThemeId = this.options.profiles.selectedTheme(user);
    const selected = selectedThemeId ? snapshot.themes.find((theme) => theme.id === selectedThemeId) : undefined;
    const configuredDefault = snapshot.themes.find((theme) => theme.id === snapshot.defaultThemeId);
    const fallback = configuredDefault ?? snapshot.themes.find((theme) => theme.id === this.lightFallbackId) ?? snapshot.themes[0];
    if (!fallback) throw new Error('Theme catalog has no usable theme');
    const theme = selected ?? fallback;
    return { selectedThemeId, activeThemeId: theme.id, theme };
  }
}
