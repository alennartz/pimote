import type { ResolvedTheme } from '@pimote/shared';

/** The palette currently applied to the document. */
export const themeRuntime = $state<{ activeTheme: ResolvedTheme | null }>({ activeTheme: null });

export function setActiveTheme(theme: ResolvedTheme): void {
  themeRuntime.activeTheme = theme;
}
