import Color from 'colorjs.io';
import type {
  AnsiColorName,
  EditorSurfaceRole,
  EditorSyntaxRole,
  ResolvedTheme,
  ThemeCatalogSnapshot,
  ThemeColorValue,
  ThemeDefinition,
  ThemeDiagnostic,
  ThemeSourceKind,
  UiColorToken,
} from '../../shared/dist/index.js';
import { builtinThemeDefinitions } from './builtin-themes.js';

/** Read boundary used by the catalog for extension and user JSON files. */
export interface ThemeCatalogReader {
  read(path: string): Promise<string>;
  /** Subscribe to changes at the user catalog path. */
  watch?(path: string, onChange: () => void): () => void;
}

/** Inputs owned by the host that builds one server theme catalog. */
export interface ThemeCatalogOptions {
  /** Built-ins in their fixed source order. */
  builtinThemes: readonly ThemeDefinition[];
  /** Extension registrations in deterministic host discovery order. */
  extensionFiles: readonly string[];
  /** Host-level user catalog path. */
  userFile: string;
  /** Native default theme ID. */
  defaultThemeId: string;
  /** File reader seam; watching is supplied by the host lifecycle. */
  reader: ThemeCatalogReader;
}

export type ThemeCatalogListener = (snapshot: ThemeCatalogSnapshot) => void;

type SourceEntry = { definition: ThemeDefinition; source: ThemeSourceKind; path: string; order: number };
type Candidate = SourceEntry & { index: number };

const UI_TOKENS: readonly UiColorToken[] = [
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
  'status-connected',
  'status-error',
  'status-reconnecting',
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
const SURFACE_ROLES: readonly EditorSurfaceRole[] = [
  'background',
  'foreground',
  'selection',
  'cursor',
  'active-line',
  'gutter-background',
  'gutter-foreground',
  'line-number',
  'active-line-number',
  'matching-bracket',
  'search-match',
];
const SYNTAX_ROLES: readonly EditorSyntaxRole[] = [
  'comment',
  'doc-comment',
  'name',
  'variable',
  'parameter',
  'type',
  'tag',
  'property',
  'attribute',
  'class',
  'label',
  'namespace',
  'macro',
  'constant',
  'function',
  'built-in',
  'keyword',
  'control-keyword',
  'definition-keyword',
  'modifier',
  'operator-keyword',
  'operator',
  'punctuation',
  'separator',
  'bracket',
  'string',
  'doc-string',
  'character',
  'attribute-value',
  'number',
  'boolean',
  'null',
  'regexp',
  'escape',
  'color',
  'url',
  'content',
  'heading',
  'content-separator',
  'list',
  'quote',
  'emphasis',
  'strong',
  'link',
  'monospace',
  'strikethrough',
  'inserted',
  'deleted',
  'changed',
  'invalid',
  'meta',
  'document-meta',
  'annotation',
  'processing-instruction',
];
const TERMINAL_ROLES: readonly AnsiColorName[] = [
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
const BUILTIN_IDS = new Set(['pimote/light', 'pimote/dark', 'dracula/dracula', 'tokyo-night/tokyo-night', 'nord/nord', 'gruvbox/dark', 'solarized/light', 'catppuccin/mocha']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The complete set of shipped theme definitions. */
export { builtinThemeDefinitions };

function emptySnapshot(defaultThemeId: string): ThemeCatalogSnapshot {
  return { revision: 0, defaultThemeId, themes: [], diagnostics: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefinition(definition: ThemeDefinition): ThemeDefinition {
  return {
    ...definition,
    ...(definition.extends ? { extends: definition.extends } : {}),
    ...(definition.palette ? { palette: { ...definition.palette } } : {}),
    ui: { ...definition.ui },
    editor: { surface: { ...definition.editor.surface }, syntax: { ...definition.editor.syntax }, terminal: { ...definition.editor.terminal } },
  };
}

function validLiteral(value: string): boolean {
  try {
    return Color.try(value) !== null;
  } catch {
    return false;
  }
}

function validateColorValue(value: unknown): value is ThemeColorValue {
  if (typeof value === 'string') return validLiteral(value);
  return isRecord(value) && typeof value.palette === 'string' && value.palette.trim().length > 0 && Object.keys(value).every((key) => key === 'palette');
}

function validateRoleMap(value: unknown, roles: readonly string[], allowPartial: boolean, label: string): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const roleSet = new Set(roles);
  for (const key of Object.keys(value)) {
    if (!roleSet.has(key)) return `${label} contains unknown role ${key}`;
    if (!validateColorValue(value[key])) return `${label}.${key} must be a CSS Color 4 literal or palette reference`;
  }
  if (!allowPartial) {
    const missing = roles.find((role) => !(role in value));
    if (missing) return `${label}.${missing} is required`;
  }
  return null;
}

function validateDefinition(value: unknown): { definition?: ThemeDefinition; message?: string } {
  if (!isRecord(value)) return { message: 'theme entry must be an object' };
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return { message: 'theme id must match publisher/theme-name' };
  if (typeof value.name !== 'string' || !value.name.trim()) return { message: 'theme name must be a non-empty string' };
  if (value.colorScheme !== 'light' && value.colorScheme !== 'dark') return { message: 'colorScheme must be light or dark' };
  if (value.extends !== undefined && (typeof value.extends !== 'string' || !ID_PATTERN.test(value.extends))) return { message: 'extends must be a theme id' };
  if (value.palette !== undefined) {
    if (!isRecord(value.palette)) return { message: 'palette must be an object' };
    for (const [name, color] of Object.entries(value.palette)) {
      if (!name.trim() || !validateLiteralOrColor(color)) return { message: `palette.${name} must be a CSS Color 4 literal` };
    }
  }
  const uiError = validateRoleMap(value.ui, UI_TOKENS, value.extends !== undefined, 'ui');
  if (uiError) return { message: uiError };
  if (!isRecord(value.editor)) return { message: 'editor must be an object' };
  const surfaceError = validateRoleMap(value.editor.surface, SURFACE_ROLES, value.extends !== undefined, 'editor.surface');
  if (surfaceError) return { message: surfaceError };
  const syntaxError = validateRoleMap(value.editor.syntax, SYNTAX_ROLES, value.extends !== undefined, 'editor.syntax');
  if (syntaxError) return { message: syntaxError };
  const terminalError = validateRoleMap(value.editor.terminal, TERMINAL_ROLES, value.extends !== undefined, 'editor.terminal');
  if (terminalError) return { message: terminalError };
  return {
    definition: {
      id: value.id,
      name: value.name,
      colorScheme: value.colorScheme,
      ...(value.extends ? { extends: value.extends } : {}),
      ...(value.palette ? { palette: { ...(value.palette as Record<string, string>) } } : {}),
      ui: { ...(value.ui as Record<UiColorToken, ThemeColorValue>) },
      editor: {
        surface: { ...(value.editor.surface as Record<EditorSurfaceRole, ThemeColorValue>) },
        syntax: { ...(value.editor.syntax as Record<EditorSyntaxRole, ThemeColorValue>) },
        terminal: { ...(value.editor.terminal as Record<AnsiColorName, ThemeColorValue>) },
      },
    },
  };
}

function validateLiteralOrColor(value: unknown): value is string {
  return typeof value === 'string' && validLiteral(value);
}

function parseFile(raw: string, path: string): { definitions: ThemeDefinition[]; diagnostics: ThemeDiagnostic[]; valid: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { definitions: [], diagnostics: [{ path, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }], valid: false };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.themes)) {
    return { definitions: [], diagnostics: [{ path, message: 'theme file must contain version 1 and a themes array' }], valid: false };
  }
  const definitions: ThemeDefinition[] = [];
  const diagnostics: ThemeDiagnostic[] = [];
  parsed.themes.forEach((entry, index) => {
    const result = validateDefinition(entry);
    if (result.definition) definitions.push(result.definition);
    else diagnostics.push({ path, message: `${result.message ?? 'invalid theme entry'} (themes[${index}])` });
  });
  return { definitions, diagnostics, valid: true };
}

function resolveValue(value: ThemeColorValue | undefined, palette: Readonly<Record<string, string>>, role: string): string {
  if (typeof value === 'string') return value;
  if (!value) throw new Error(`missing color value for ${role}`);
  if (!Object.prototype.hasOwnProperty.call(palette, value.palette) || typeof palette[value.palette] !== 'string') {
    throw new Error(`missing palette swatch ${value.palette} for ${role}`);
  }
  return palette[value.palette];
}

function mergeRecord<K extends string>(
  parent: Readonly<Record<K, string>> | undefined,
  own: Readonly<Partial<Record<K, ThemeColorValue>>>,
  palette: Readonly<Record<string, string>>,
  label: string,
): Record<K, string> {
  const merged: Partial<Record<K, string>> = { ...(parent ?? {}) };
  for (const [key, value] of Object.entries(own)) merged[key as K] = resolveValue(value as ThemeColorValue, palette, `${label}.${key}`);
  return merged as Record<K, string>;
}

function resolveDefinitions(entries: readonly SourceEntry[], diagnostics: ThemeDiagnostic[]): ResolvedTheme[] {
  const candidates = new Map<string, Candidate[]>();
  entries.forEach((entry, index) => {
    const list = candidates.get(entry.definition.id) ?? [];
    list.push({ ...entry, index });
    candidates.set(entry.definition.id, list);
  });
  const resolved = new Map<string, ResolvedTheme>();
  const resolvedCandidateIndexes = new Map<string, number>();
  const resolvedPalettes = new Map<string, Record<string, string>>();
  const resolving: string[] = [];
  const failed = new Set<number>();

  const resolveId = (id: string): ResolvedTheme | undefined => {
    const existing = resolved.get(id);
    if (existing) return existing;
    const options = candidates.get(id) ?? [];
    if (options.length === 0) return undefined;
    if (resolving.includes(id)) throw new Error(`inheritance cycle: ${[...resolving, id].join(' -> ')}`);
    resolving.push(id);
    try {
      for (const candidate of options) {
        try {
          const definition = candidate.definition;
          const parent = definition.extends ? resolveId(definition.extends) : undefined;
          if (definition.extends && !parent) throw new Error(`missing inheritance base ${definition.extends}`);
          const ownPalette = definition.palette ?? {};
          const inheritedPalette = parent ? (resolvedPalettes.get(parent.id) ?? {}) : {};
          const palette = { ...inheritedPalette, ...ownPalette };
          const ui = mergeRecord(parent?.ui, definition.ui, palette, 'ui');
          const surface = mergeRecord(parent?.editor.surface, definition.editor.surface, palette, 'editor.surface');
          const syntax = mergeRecord(parent?.editor.syntax, definition.editor.syntax, palette, 'editor.syntax');
          const terminal = mergeRecord(parent?.editor.terminal, definition.editor.terminal, palette, 'editor.terminal');
          for (const role of UI_TOKENS) if (!(role in ui)) throw new Error(`ui.${role} is required`);
          for (const role of SURFACE_ROLES) if (!(role in surface)) throw new Error(`editor.surface.${role} is required`);
          for (const role of SYNTAX_ROLES) if (!(role in syntax)) throw new Error(`editor.syntax.${role} is required`);
          for (const role of TERMINAL_ROLES) if (!(role in terminal)) throw new Error(`editor.terminal.${role} is required`);
          const theme: ResolvedTheme = {
            id: definition.id,
            name: definition.name,
            source: candidate.source,
            colorScheme: definition.colorScheme,
            ui,
            editor: { surface, syntax, terminal },
          };
          resolved.set(id, theme);
          resolvedCandidateIndexes.set(id, candidate.index);
          resolvedPalettes.set(id, palette);
          return theme;
        } catch (error) {
          failed.add(candidate.index);
          diagnostics.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error), themeId: candidate.definition.id, source: candidate.source });
        }
      }
      return undefined;
    } finally {
      resolving.pop();
    }
  };

  for (const [id, options] of candidates) {
    if (BUILTIN_IDS.has(id) && options.some((candidate) => candidate.source !== 'builtin')) {
      for (const candidate of options.filter((entry) => entry.source !== 'builtin'))
        diagnostics.push({ path: candidate.path, message: 'reserved built-in theme id', themeId: id, source: candidate.source });
    }
    resolveId(id);
    const chosenIndex = resolvedCandidateIndexes.get(id);
    if (options.length > 1 && chosenIndex !== undefined) {
      for (const duplicate of options.filter((candidate) => candidate.index > chosenIndex)) {
        if (!BUILTIN_IDS.has(id) || duplicate.source === 'builtin')
          diagnostics.push({ path: duplicate.path, message: 'duplicate theme id; first valid definition wins', themeId: id, source: duplicate.source });
      }
    }
  }
  void failed;
  return entries
    .filter((entry) => resolved.has(entry.definition.id))
    .map((entry) => resolved.get(entry.definition.id)!)
    .filter((theme, index, all) => all.findIndex((item) => item.id === theme.id) === index);
}

/** Server boundary for built-in, extension, and user theme sources. */
export class ThemeCatalog {
  private extensionFiles: string[];
  private current: ThemeCatalogSnapshot;
  private listeners = new Set<ThemeCatalogListener>();
  private stopWatching: (() => void) | undefined;
  private loaded = false;
  private userDefinitions: ThemeDefinition[] | null = null;
  private reloadChain: Promise<ThemeCatalogSnapshot> = Promise.resolve(emptySnapshot('pimote/light'));

  constructor(private readonly options: ThemeCatalogOptions) {
    this.extensionFiles = [...options.extensionFiles];
    this.current = emptySnapshot(options.defaultThemeId);
  }

  async load(): Promise<ThemeCatalogSnapshot> {
    if (this.loaded) return this.current;
    this.loaded = true;
    if (this.options.reader.watch) this.stopWatching = this.options.reader.watch(this.options.userFile, () => void this.reload());
    return this.reload();
  }

  async reload(): Promise<ThemeCatalogSnapshot> {
    const operation = this.reloadChain.then(() => this.readAndPublish());
    this.reloadChain = operation.catch(() => this.current);
    return operation;
  }

  snapshot(): ThemeCatalogSnapshot {
    return this.current;
  }

  onChange(listener: ThemeCatalogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setDefaultTheme(defaultThemeId: string): Promise<ThemeCatalogSnapshot> {
    if (defaultThemeId === this.current.defaultThemeId) return this.current;
    this.current = { ...this.current, defaultThemeId, revision: this.current.revision + 1 };
    this.publish();
    return this.current;
  }

  /** Replace extension registrations after a host reload. */
  async replaceExtensionFiles(extensionFiles: readonly string[]): Promise<ThemeCatalogSnapshot> {
    this.extensionFiles = [...extensionFiles];
    return this.reload();
  }

  async close(): Promise<void> {
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.listeners.clear();
  }

  private async readAndPublish(): Promise<ThemeCatalogSnapshot> {
    const diagnostics: ThemeDiagnostic[] = [];
    const entries: SourceEntry[] = [];
    let order = 0;
    for (const definition of this.options.builtinThemes.length > 0 ? this.options.builtinThemes : builtinThemeDefinitions()) {
      entries.push({ definition: cloneDefinition(definition), source: 'builtin', path: '<builtin>', order: order++ });
    }
    for (const path of this.extensionFiles) {
      let raw: string;
      try {
        raw = await this.options.reader.read(path);
      } catch (error) {
        diagnostics.push({ path, message: `failed to read theme file: ${error instanceof Error ? error.message : String(error)}`, source: 'extension' });
        continue;
      }
      const parsed = parseFile(raw, path);
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, source: 'extension' as const })));
      for (const definition of parsed.definitions) entries.push({ definition, source: 'extension', path, order: order++ });
    }
    let userDefinitions: ThemeDefinition[] = [];
    try {
      const parsed = parseFile(await this.options.reader.read(this.options.userFile), this.options.userFile);
      if (parsed.valid) {
        userDefinitions = parsed.definitions;
        this.userDefinitions = userDefinitions.map(cloneDefinition);
      } else if (this.userDefinitions) {
        userDefinitions = this.userDefinitions.map(cloneDefinition);
      }
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, source: 'user' as const })));
    } catch (error) {
      diagnostics.push({ path: this.options.userFile, message: `failed to read theme file: ${error instanceof Error ? error.message : String(error)}`, source: 'user' });
      userDefinitions = this.userDefinitions?.map(cloneDefinition) ?? [];
    }
    for (const definition of userDefinitions) entries.push({ definition, source: 'user', path: this.options.userFile, order: order++ });

    const themes = resolveDefinitions(entries, diagnostics);
    const nextSignature = JSON.stringify({ defaultThemeId: this.current.defaultThemeId, extensionFiles: this.extensionFiles, themes, diagnostics });
    const previousSignature = JSON.stringify({
      defaultThemeId: this.current.defaultThemeId,
      extensionFiles: this.extensionFiles,
      themes: this.current.themes,
      diagnostics: this.current.diagnostics,
    });
    if (nextSignature === previousSignature && this.current.revision > 0) return this.current;
    this.current = { revision: this.current.revision + 1, defaultThemeId: this.current.defaultThemeId, themes, diagnostics };
    this.publish();
    return this.current;
  }

  private publish(): void {
    const snapshot = this.current;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[theme-catalog] listener failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }
}
