import Color from 'colorjs.io';
import type {
  AnsiColorName,
  EditorSurfaceRole,
  ResolvedTheme,
  SyntaxScope,
  ThemeCatalogSnapshot,
  ThemeColorValue,
  ThemeDefinition,
  ThemeDiagnostic,
  ThemeSourceKind,
  UiColorToken,
} from '../../shared/dist/index.js';
import {
  ANSI_COLOR_NAMES,
  EDITOR_SURFACE_ROLES,
  LEGACY_SYNTAX_ROLE_SCOPES,
  SYNTAX_SCOPES,
  UI_COLOR_TOKENS,
  qualifyTokenStatements,
  resolveTokens,
} from '../../shared/dist/index.js';
import { builtinThemeDefinitions } from './builtin-themes.js';
import { BUILTIN_THEME_IDS, normalizeBuiltinThemeId } from './theme-ids.js';

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

type SourceEntry = { definition: ThemeDefinition; source: ThemeSourceKind; path: string };
type Candidate = SourceEntry & { index: number };

const UI_TOKENS = UI_COLOR_TOKENS;
const SURFACE_ROLES = EDITOR_SURFACE_ROLES;
const TERMINAL_ROLES = ANSI_COLOR_NAMES;
const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_THEME_IDS);
/** A theme cannot inherit through more levels than this. */
const MAX_INHERITANCE_DEPTH = 64;
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
    editor: {
      surface: { ...definition.editor.surface },
      syntax: { ...definition.editor.syntax },
      terminal: { ...definition.editor.terminal },
    },
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

/** Accept the flat role names that predate the TextMate roots. */
function normalizeSyntaxScopes(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, color] of Object.entries(value)) {
    const scope = LEGACY_SYNTAX_ROLE_SCOPES[key] ?? key;
    if (scope !== key && scope in result) continue;
    result[scope] = color;
  }
  return result;
}

function validateRoleMap(value: unknown, roles: readonly string[], label: string): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const roleSet = new Set(roles);
  for (const key of Object.keys(value)) {
    if (!roleSet.has(key)) return `${label} contains unknown role ${key}`;
    if (!validateColorValue(value[key])) return `${label}.${key} must be a CSS Color 4 literal or palette reference`;
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
  const uiError = validateRoleMap(value.ui, UI_TOKENS, 'ui');
  if (uiError) return { message: uiError };
  if (!isRecord(value.editor)) return { message: 'editor must be an object' };
  const surfaceError = validateRoleMap(value.editor.surface, SURFACE_ROLES, 'editor.surface');
  if (surfaceError) return { message: surfaceError };
  if (!isRecord(value.editor.syntax)) return { message: 'editor.syntax must be an object' };
  const syntaxValues = normalizeSyntaxScopes(value.editor.syntax);
  const syntaxError = validateRoleMap(syntaxValues, SYNTAX_SCOPES, 'editor.syntax');
  if (syntaxError) return { message: syntaxError };
  const terminalError = validateRoleMap(value.editor.terminal, TERMINAL_ROLES, 'editor.terminal');
  if (terminalError) return { message: terminalError };
  return {
    definition: {
      id: value.id,
      name: value.name,
      colorScheme: value.colorScheme,
      ...(value.extends ? { extends: normalizeBuiltinThemeId(value.extends) } : {}),
      ...(value.palette ? { palette: { ...(value.palette as Record<string, string>) } } : {}),
      ui: { ...(value.ui as Record<UiColorToken, ThemeColorValue>) },
      editor: {
        surface: { ...(value.editor.surface as Record<EditorSurfaceRole, ThemeColorValue>) },
        syntax: { ...(syntaxValues as Record<SyntaxScope, ThemeColorValue>) },
        terminal: { ...(value.editor.terminal as Record<AnsiColorName, ThemeColorValue>) },
      },
    },
  };
}

function validateLiteralOrColor(value: unknown): value is string {
  return typeof value === 'string' && validLiteral(value);
}

/** Parse and validate one theme file. */
export function parseThemeFile(raw: string, path: string): { definitions: ThemeDefinition[]; diagnostics: ThemeDiagnostic[]; valid: boolean } {
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

/** Values a theme states, with palette references replaced by their literals. */
export interface StatedMaps {
  ui: Record<string, string>;
  'editor.surface': Record<string, string>;
  'editor.syntax': Record<string, string>;
  'editor.terminal': Record<string, string>;
}

/** What one resolved theme stated itself, and what it inherited beside it. */
export interface ResolvedThemeStatements {
  /** Own statements merged over the base theme's statements. */
  merged: StatedMaps;
  /** Only the statements this theme makes itself. */
  own: StatedMaps;
}

/** One resolved theme with the statements that produced it. */
export interface ResolvedThemeSources {
  themes: ResolvedTheme[];
  statements: Map<string, ResolvedThemeStatements>;
  diagnostics: ThemeDiagnostic[];
}

function mergeStated(
  parent: Readonly<Record<string, string>> | undefined,
  own: Readonly<Record<string, ThemeColorValue>>,
  palette: Readonly<Record<string, string>>,
  label: string,
): Record<string, string> {
  const merged: Record<string, string> = { ...(parent ?? {}) };
  for (const [key, value] of Object.entries(own)) merged[key] = resolveValue(value as ThemeColorValue, palette, `${label}.${key}`);
  return merged;
}

function unqualified<T extends string>(values: Readonly<Record<string, string>>, namespace: string, names: readonly T[]): Record<T, string> {
  return Object.fromEntries(names.map((name) => [name, values[`${namespace}.${name}`] ?? ''])) as Record<T, string>;
}

/** Resolve theme sources into themes, keeping the statements that produced each one. */
export function resolveThemeDefinitions(entries: readonly SourceEntry[]): ResolvedThemeSources {
  const diagnostics: ThemeDiagnostic[] = [];
  const candidates = new Map<string, Candidate[]>();
  entries.forEach((entry, index) => {
    const list = candidates.get(entry.definition.id) ?? [];
    list.push({ ...entry, index });
    candidates.set(entry.definition.id, list);
  });
  const resolved = new Map<string, ResolvedTheme>();
  const resolvedCandidateIndexes = new Map<string, number>();
  const resolvedPalettes = new Map<string, Record<string, string>>();
  const resolvedStatements = new Map<string, ResolvedThemeStatements>();
  const resolving: string[] = [];
  const failedCandidates = new Set<number>();
  const failedIds = new Set<string>();

  const resolveId = (id: string): ResolvedTheme | undefined => {
    const existing = resolved.get(id);
    if (existing) return existing;
    if (failedIds.has(id)) return undefined;
    const options = candidates.get(id) ?? [];
    if (options.length === 0) return undefined;
    if (resolving.includes(id)) throw new Error(`inheritance cycle: ${[...resolving, id].join(' -> ')}`);
    if (resolving.length >= MAX_INHERITANCE_DEPTH) throw new Error(`inheritance chain exceeds ${MAX_INHERITANCE_DEPTH} levels`);
    resolving.push(id);
    try {
      for (const candidate of options) {
        if (failedCandidates.has(candidate.index)) continue;
        try {
          const definition = candidate.definition;
          const parent = definition.extends ? resolveId(definition.extends) : undefined;
          if (definition.extends && !parent) throw new Error(`missing inheritance base ${definition.extends}`);
          const ownPalette = definition.palette ?? {};
          const inheritedPalette = parent ? (resolvedPalettes.get(parent.id) ?? {}) : {};
          const palette = { ...inheritedPalette, ...ownPalette };
          const inherited = parent ? resolvedStatements.get(parent.id)?.merged : undefined;
          const own: StatedMaps = {
            ui: mergeStated(undefined, definition.ui, palette, 'ui'),
            'editor.surface': mergeStated(undefined, definition.editor.surface, palette, 'editor.surface'),
            'editor.syntax': mergeStated(undefined, definition.editor.syntax, palette, 'editor.syntax'),
            'editor.terminal': mergeStated(undefined, definition.editor.terminal, palette, 'editor.terminal'),
          };
          const statements: ResolvedThemeStatements = {
            merged: {
              ui: { ...(inherited?.ui ?? {}), ...own.ui },
              'editor.surface': { ...(inherited?.['editor.surface'] ?? {}), ...own['editor.surface'] },
              'editor.syntax': { ...(inherited?.['editor.syntax'] ?? {}), ...own['editor.syntax'] },
              'editor.terminal': { ...(inherited?.['editor.terminal'] ?? {}), ...own['editor.terminal'] },
            },
            own,
          };
          const values = resolveTokens(qualifyTokenStatements(statements.merged)).values;
          const theme: ResolvedTheme = {
            id: definition.id,
            name: definition.name,
            source: candidate.source,
            colorScheme: definition.colorScheme,
            ui: unqualified(values, 'ui', UI_TOKENS),
            editor: {
              surface: unqualified(values, 'editor.surface', SURFACE_ROLES),
              syntax: unqualified(values, 'editor.syntax', SYNTAX_SCOPES),
              terminal: unqualified(values, 'editor.terminal', TERMINAL_ROLES),
            },
          };
          resolved.set(id, theme);
          resolvedCandidateIndexes.set(id, candidate.index);
          resolvedPalettes.set(id, palette);
          resolvedStatements.set(id, statements);
          return theme;
        } catch (error) {
          failedCandidates.add(candidate.index);
          diagnostics.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error), themeId: candidate.definition.id, source: candidate.source });
        }
      }
      failedIds.add(id);
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
  const themes = entries
    .filter((entry) => resolved.has(entry.definition.id))
    .map((entry) => resolved.get(entry.definition.id)!)
    .filter((theme, index, all) => all.findIndex((item) => item.id === theme.id) === index);
  return { themes, statements: resolvedStatements, diagnostics };
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
    this.current = emptySnapshot(normalizeBuiltinThemeId(options.defaultThemeId));
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
    defaultThemeId = normalizeBuiltinThemeId(defaultThemeId);
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
    for (const definition of this.options.builtinThemes.length > 0 ? this.options.builtinThemes : builtinThemeDefinitions()) {
      entries.push({ definition: cloneDefinition(definition), source: 'builtin', path: '<builtin>' });
    }
    for (const path of this.extensionFiles) {
      let raw: string;
      try {
        raw = await this.options.reader.read(path);
      } catch (error) {
        diagnostics.push({ path, message: `failed to read theme file: ${error instanceof Error ? error.message : String(error)}`, source: 'extension' });
        continue;
      }
      const parsed = parseThemeFile(raw, path);
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, source: 'extension' as const })));
      for (const definition of parsed.definitions) entries.push({ definition, source: 'extension', path });
    }
    let userDefinitions: ThemeDefinition[] = [];
    try {
      const parsed = parseThemeFile(await this.options.reader.read(this.options.userFile), this.options.userFile);
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
    for (const definition of userDefinitions) entries.push({ definition, source: 'user', path: this.options.userFile });

    const resolution = resolveThemeDefinitions(entries);
    diagnostics.push(...resolution.diagnostics);
    const themes = resolution.themes;
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
