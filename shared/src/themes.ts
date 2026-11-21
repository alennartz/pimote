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
    syntax: Partial<Record<SyntaxScope, ThemeColorValue>>;
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
  | 'status-streaming-on-primary'
  | 'status-connected'
  | 'status-error'
  | 'status-reconnecting'
  | 'status-reconnecting-on-primary'
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

/** Optional selected-chip foreground roles default to the primary foreground. */
export const OPTIONAL_UI_ROLE_FALLBACKS = {
  'status-streaming-on-primary': 'primary-foreground',
  'status-reconnecting-on-primary': 'primary-foreground',
} satisfies Partial<Record<UiColorToken, UiColorToken>>;

/** Theme-independent editor surface roles. */
export type EditorSurfaceRole =
  | 'background'
  | 'foreground'
  | 'selection'
  | 'selection-foreground'
  | 'cursor'
  | 'active-line'
  | 'gutter-background'
  | 'gutter-foreground'
  | 'line-number'
  | 'active-line-number'
  | 'matching-bracket'
  | 'search-match'
  | 'diff-addition-background'
  | 'diff-deletion-background';

/** Every editor surface role in catalog order. */
export const EDITOR_SURFACE_ROLES: readonly EditorSurfaceRole[] = [
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

/** The TextMate root groups. Every syntax token belongs to exactly one root. */
export type SyntaxRoot = 'comment' | 'constant' | 'entity' | 'invalid' | 'keyword' | 'markup' | 'meta' | 'storage' | 'string' | 'support' | 'variable';

/**
 * TextMate child scopes. A theme sets a child only to depart from its root color.
 * Every name is a path from the TextMate naming conventions, save the four marked
 * VS Code conventions, which TextMate itself leaves unnamed.
 */
export type SyntaxChild =
  | 'comment.documentation'
  | 'constant.numeric'
  | 'constant.language'
  | 'constant.character.escape'
  | 'constant.other'
  | 'entity.name.function'
  | 'entity.name.function.macro'
  | 'entity.name.type'
  | 'entity.name.tag'
  | 'entity.name.namespace'
  | 'entity.name.label'
  | 'entity.other.attribute-name'
  | 'keyword.control'
  | 'keyword.operator'
  | 'markup.heading'
  | 'markup.list'
  | 'markup.quote'
  | 'markup.italic'
  | 'markup.bold'
  | 'markup.underline.link'
  | 'markup.raw'
  | 'markup.strikethrough'
  | 'markup.inserted'
  | 'markup.deleted'
  | 'markup.changed'
  | 'storage.type'
  | 'storage.modifier'
  | 'string.quoted'
  | 'string.regexp'
  | 'string.other'
  | 'support.function'
  | 'support.type'
  | 'support.constant'
  | 'support.variable'
  | 'variable.parameter'
  | 'variable.other'
  | 'variable.other.property'
  | 'variable.other.enum-member'
  | 'variable.language';

/** A root group or one of its child scopes. */
export type SyntaxScope = SyntaxRoot | SyntaxChild;

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

/** Every root group in catalog order. */
export const SYNTAX_ROOTS: readonly SyntaxRoot[] = ['comment', 'constant', 'entity', 'invalid', 'keyword', 'markup', 'meta', 'storage', 'string', 'support', 'variable'];

/** Roots a theme must paint. `meta` groups structure and inherits the editor foreground. */
export const REQUIRED_SYNTAX_ROOTS: readonly SyntaxRoot[] = SYNTAX_ROOTS.filter((root) => root !== 'meta');

/** Every child scope in catalog order. */
export const SYNTAX_CHILDREN: readonly SyntaxChild[] = [
  'comment.documentation',
  'constant.numeric',
  'constant.language',
  'constant.character.escape',
  'constant.other',
  'entity.name.function',
  'entity.name.function.macro',
  'entity.name.type',
  'entity.name.tag',
  'entity.name.namespace',
  'entity.name.label',
  'entity.other.attribute-name',
  'keyword.control',
  'keyword.operator',
  'markup.heading',
  'markup.list',
  'markup.quote',
  'markup.italic',
  'markup.bold',
  'markup.underline.link',
  'markup.raw',
  'markup.strikethrough',
  'markup.inserted',
  'markup.deleted',
  'markup.changed',
  'storage.type',
  'storage.modifier',
  'string.quoted',
  'string.regexp',
  'string.other',
  'support.function',
  'support.type',
  'support.constant',
  'support.variable',
  'variable.parameter',
  'variable.other',
  'variable.other.property',
  'variable.other.enum-member',
  'variable.language',
];

/** Every scope in catalog order. */
export const SYNTAX_SCOPES: readonly SyntaxScope[] = [...SYNTAX_ROOTS, ...SYNTAX_CHILDREN];

/** The CSS custom property that publishes one editor token. */
export function editorPropertyName(token: SyntaxScope | EditorSurfaceRole): string {
  return `--pimote-editor-${token.replaceAll('.', '-')}`;
}

/** The root group a scope inherits its color from. */
export function syntaxScopeRoot(scope: SyntaxScope): SyntaxRoot {
  return scope.split('.')[0] as SyntaxRoot;
}

/** Theme-file aliases for the flat role names that predate the root groups. */
export const LEGACY_SYNTAX_ROLE_SCOPES: Readonly<Record<string, SyntaxScope>> = {
  'doc-comment': 'comment.documentation',
  name: 'entity',
  parameter: 'variable.parameter',
  type: 'entity.name.type',
  tag: 'entity.name.tag',
  property: 'variable.other.property',
  attribute: 'entity.other.attribute-name',
  class: 'entity.name.type',
  label: 'entity.name.label',
  namespace: 'entity.name.namespace',
  macro: 'entity.name.function.macro',
  function: 'entity.name.function',
  'built-in': 'support',
  'control-keyword': 'keyword.control',
  'definition-keyword': 'storage',
  modifier: 'storage.modifier',
  'operator-keyword': 'keyword.operator',
  operator: 'keyword.operator',
  punctuation: 'meta',
  separator: 'meta',
  bracket: 'meta',
  'doc-string': 'string.quoted',
  character: 'constant',
  'attribute-value': 'string.quoted',
  number: 'constant.numeric',
  boolean: 'constant.language',
  null: 'constant.language',
  regexp: 'string.regexp',
  escape: 'constant.character.escape',
  color: 'constant.other',
  url: 'markup.underline.link',
  content: 'markup.raw',
  heading: 'markup.heading',
  'content-separator': 'markup',
  list: 'markup.list',
  quote: 'markup.quote',
  emphasis: 'markup.italic',
  strong: 'markup.bold',
  link: 'markup.underline.link',
  monospace: 'markup.raw',
  strikethrough: 'markup.strikethrough',
  inserted: 'markup.inserted',
  deleted: 'markup.deleted',
  changed: 'markup.changed',
  'document-meta': 'meta',
  annotation: 'meta',
  'processing-instruction': 'meta',
};

/** A fully resolved theme sent to a PWA client. */
export interface ResolvedTheme {
  id: string;
  name: string;
  source: ThemeSourceKind;
  colorScheme: 'light' | 'dark';
  ui: Record<UiColorToken, string>;
  editor: {
    surface: Record<EditorSurfaceRole, string>;
    syntax: Record<SyntaxScope, string>;
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
