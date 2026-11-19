/** A versioned JSON document contributed by the host or an extension. */
export interface ThemeFile {
  version: 1;
  themes: ThemeDefinition[];
}

/** A user-facing paired UI and code palette. */
export interface ThemeDefinition {
  id: string;
  name: string;
  colorScheme: 'light' | 'dark';
  extends?: string;
  palette?: Record<string, string>;
  ui: Partial<Record<UiColorToken, ThemeColorValue>>;
  editor: {
    surface: Partial<Record<EditorSurfaceRole, ThemeColorValue>>;
    syntax: Partial<Record<EditorSyntaxRole, ThemeColorValue>>;
    terminal: Partial<Record<AnsiColorName, ThemeColorValue>>;
  };
}

/** A literal CSS color or a reference to a named color in the theme palette. */
export type ThemeColorValue = string | { palette: string };

/** Stable source precedence for resolved catalog entries. */
export type ThemeSourceKind = 'builtin' | 'extension' | 'user';

/** Every color-valued Pimote UI design token. */
export type UiColorToken =
  | 'background'
  | 'foreground'
  | 'card'
  | 'card-foreground'
  | 'popover'
  | 'popover-foreground'
  | 'primary'
  | 'primary-foreground'
  | 'secondary'
  | 'secondary-foreground'
  | 'muted'
  | 'muted-foreground'
  | 'accent'
  | 'accent-foreground'
  | 'destructive'
  | 'warning'
  | 'warning-foreground'
  | 'border'
  | 'input'
  | 'ring'
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'sidebar'
  | 'sidebar-foreground'
  | 'sidebar-primary'
  | 'sidebar-primary-foreground'
  | 'sidebar-accent'
  | 'sidebar-accent-foreground'
  | 'sidebar-border'
  | 'sidebar-ring'
  | 'status-active'
  | 'status-streaming'
  | 'status-connected'
  | 'status-error'
  | 'status-reconnecting'
  | 'surface-sunken'
  | 'surface-raised'
  | 'surface-subtle'
  | 'surface-hover'
  | 'error-accent'
  | 'error-surface'
  | 'error-foreground'
  | 'error-avatar-fg'
  | 'skill-accent'
  | 'skill-surface'
  | 'skill-foreground'
  | 'skill-foreground-hover'
  | 'bash-accent'
  | 'custom-accent'
  | 'custom-surface'
  | 'custom-foreground'
  | 'custom-foreground-hover'
  | 'link'
  | 'link-hover'
  | 'avatar-bg'
  | 'avatar-fg'
  | 'shadow-color';

/** Theme-independent editor surface roles. */
export type EditorSurfaceRole =
  | 'background'
  | 'foreground'
  | 'selection'
  | 'cursor'
  | 'active-line'
  | 'gutter-background'
  | 'gutter-foreground'
  | 'line-number'
  | 'active-line-number'
  | 'matching-bracket'
  | 'search-match';

/** Theme-independent syntax roles shared by CodeMirror and Highlight.js. */
export type EditorSyntaxRole =
  | 'comment'
  | 'doc-comment'
  | 'name'
  | 'variable'
  | 'parameter'
  | 'type'
  | 'tag'
  | 'property'
  | 'attribute'
  | 'class'
  | 'label'
  | 'namespace'
  | 'macro'
  | 'constant'
  | 'function'
  | 'built-in'
  | 'keyword'
  | 'control-keyword'
  | 'definition-keyword'
  | 'modifier'
  | 'operator-keyword'
  | 'operator'
  | 'punctuation'
  | 'separator'
  | 'bracket'
  | 'string'
  | 'doc-string'
  | 'character'
  | 'attribute-value'
  | 'number'
  | 'boolean'
  | 'null'
  | 'regexp'
  | 'escape'
  | 'color'
  | 'url'
  | 'content'
  | 'heading'
  | 'content-separator'
  | 'list'
  | 'quote'
  | 'emphasis'
  | 'strong'
  | 'link'
  | 'monospace'
  | 'strikethrough'
  | 'inserted'
  | 'deleted'
  | 'changed'
  | 'invalid'
  | 'meta'
  | 'document-meta'
  | 'annotation'
  | 'processing-instruction';

/** The standard sixteen ANSI color slots. */
export type AnsiColorName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bright-black'
  | 'bright-red'
  | 'bright-green'
  | 'bright-yellow'
  | 'bright-blue'
  | 'bright-magenta'
  | 'bright-cyan'
  | 'bright-white';

/** A fully resolved theme sent to a PWA client. */
export interface ResolvedTheme {
  id: string;
  name: string;
  source: ThemeSourceKind;
  colorScheme: 'light' | 'dark';
  ui: Record<UiColorToken, string>;
  editor: {
    surface: Record<EditorSurfaceRole, string>;
    syntax: Record<EditorSyntaxRole, string>;
    terminal: Record<AnsiColorName, string>;
  };
}

/** One catalog diagnostic. Low contrast is not a diagnostic. */
export interface ThemeDiagnostic {
  path: string;
  message: string;
  themeId?: string;
  source?: ThemeSourceKind;
}

/** The revisioned snapshot requested by the PWA. */
export interface ThemeCatalogSnapshot {
  revision: number;
  defaultThemeId: string;
  themes: ResolvedTheme[];
  diagnostics: ThemeDiagnostic[];
}
