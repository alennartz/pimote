import type { AnsiColorName, EditorSurfaceRole, ResolvedTheme, SyntaxScope, ThemeDefinition, ThemeSourceKind, UiColorToken } from '../src/themes.js';
import { SYNTAX_SCOPES } from '../src/themes.js';

const uiTokens: UiColorToken[] = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'warning',
  'warning-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'status-active',
  'status-streaming',
  'status-streaming-on-primary',
  'status-connected',
  'status-error',
  'status-reconnecting',
  'status-reconnecting-on-primary',
  'surface-sunken',
  'surface-raised',
  'surface-subtle',
  'surface-hover',
  'error-accent',
  'error-surface',
  'error-foreground',
  'error-avatar-fg',
  'skill-accent',
  'skill-surface',
  'skill-foreground',
  'skill-foreground-hover',
  'bash-accent',
  'custom-accent',
  'custom-surface',
  'custom-foreground',
  'custom-foreground-hover',
  'link',
  'link-hover',
  'avatar-bg',
  'avatar-fg',
  'shadow-color',
];

const surfaceRoles: EditorSurfaceRole[] = [
  'background',
  'foreground',
  'selection',
  'selection-foreground',
  'cursor',
  'active-line',
  'gutter-background',
  'gutter-foreground',
  'line-number',
  'active-line-number',
  'matching-bracket',
  'search-match',
  'diff-addition-background',
  'diff-deletion-background',
];

const terminalRoles: AnsiColorName[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
];

function colors<K extends string>(keys: readonly K[], color: string): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, color])) as Record<K, string>;
}

export function resolvedTheme(id: string, name = id, source: ThemeSourceKind = 'builtin'): ResolvedTheme {
  return {
    id,
    name,
    source,
    colorScheme: id.includes('light') ? 'light' : 'dark',
    ui: colors(uiTokens, '#111111'),
    editor: {
      surface: colors(surfaceRoles, '#222222'),
      syntax: colors(SYNTAX_SCOPES as readonly SyntaxScope[], '#333333'),
      terminal: colors(terminalRoles, '#444444'),
    },
  };
}

export function themeDefinition(id: string, name = id): ThemeDefinition {
  const { source: _source, ...definition } = resolvedTheme(id, name);
  return definition;
}
