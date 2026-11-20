export const LEGACY_BUILTIN_THEME_IDS = {
  'dracula/dracula': 'pimote/dracula',
  'tokyo-night/tokyo-night': 'pimote/tokyo-night',
  'nord/nord': 'pimote/nord',
  'gruvbox/dark': 'pimote/gruvbox-dark',
  'solarized/light': 'pimote/solarized-light',
  'catppuccin/mocha': 'pimote/catppuccin-mocha',
  'catppuccin/latte': 'pimote/catppuccin-latte',
} as const;

export const BUILTIN_THEME_IDS = ['pimote/light', 'pimote/dark', ...Object.values(LEGACY_BUILTIN_THEME_IDS)] as const;

export function normalizeBuiltinThemeId(id: string): string {
  return LEGACY_BUILTIN_THEME_IDS[id as keyof typeof LEGACY_BUILTIN_THEME_IDS] ?? id;
}
