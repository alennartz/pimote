import type { UserSummary } from '../../../shared/dist/index.js';
import type { ThemeSelection } from '../theme-preferences.js';
import type { ManagerThemeAssignment, ManagerThemeDemoBundle, ManagerThemePort } from './types.js';

export interface ManagerThemeProfilesPort {
  summaries(): UserSummary[];
}

export interface ManagerThemePreferencesPort {
  setKnownUserTheme(user: string, themeId: string | null): Promise<ThemeSelection>;
}

export interface ManagerThemePortOptions {
  profiles: ManagerThemeProfilesPort;
  preferences: ManagerThemePreferencesPort;
  broadcastUserThemeChanged(user: string): void;
  prepareDemo(themeFile: string, signal?: AbortSignal): Promise<ManagerThemeDemoBundle>;
}

/** Adapt profile, preference, broadcast, and demo owners to the manager seam. */
export function createManagerThemePort(options: ManagerThemePortOptions): ManagerThemePort {
  const listKnownUsers = (): UserSummary[] => options.profiles.summaries().map((user) => ({ ...user }));

  const setKnownUserTheme = async (user: string, themeId: string | null): Promise<ManagerThemeAssignment> => {
    if (!listKnownUsers().some((candidate) => candidate.name === user)) throw new Error(`Unknown user: ${user}`);
    const selection = await options.preferences.setKnownUserTheme(user, themeId);
    options.broadcastUserThemeChanged(user);
    return {
      user,
      selectedThemeId: selection.selectedThemeId,
      activeThemeId: selection.activeThemeId,
      themeName: selection.theme.name,
      colorScheme: selection.theme.colorScheme,
      source: selection.theme.source,
    };
  };

  return {
    listKnownUsers,
    setKnownUserTheme,
    prepareDemo: options.prepareDemo,
  };
}
