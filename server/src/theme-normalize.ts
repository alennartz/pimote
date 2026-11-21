import type { ThemeColorValue, ThemeDefinition, ThemeDiagnostic } from '../../shared/dist/index.js';
import { DESIGN_TOKENS, qualifyTokenStatements, resolveTokens, themeProfile, type ThemeProfile } from '../../shared/dist/index.js';
import { parseThemeFile, resolveThemeDefinitions, type ResolvedThemeStatements } from './theme-catalog.js';

/** A file rewritten into its canonical minimal form. */
export interface ThemeNormalizeResult {
  /** Canonical file text. Unchanged input text when the file has diagnostics. */
  text: string;
  /** Whether the input text differs from the canonical form. */
  changed: boolean;
  /** The rewritten definitions, in file order. */
  themes: ThemeDefinition[];
  /** How far each rewritten theme's own statements reach into the token graph. */
  profiles: Record<string, ThemeProfile>;
  diagnostics: ThemeDiagnostic[];
}

export interface ThemeNormalizeOptions {
  /** Base themes available to `extends`, normally the built-ins. */
  builtinThemes?: readonly ThemeDefinition[];
  /** Diagnostics path label. */
  path?: string;
}

function resolvedOwn(statements: ResolvedThemeStatements): Record<string, string> {
  return qualifyTokenStatements(statements.own);
}

function resolvedBaseline(statements: ResolvedThemeStatements | undefined): Record<string, string> {
  return statements ? qualifyTokenStatements(statements.merged) : {};
}

/** Drop every statement whose removal leaves the resolved palette unchanged. */
function minimize(own: Readonly<Record<string, string>>, baseline: Readonly<Record<string, string>>): Record<string, string> {
  const target = resolveTokens({ ...baseline, ...own }).values;
  const minimal: Record<string, string> = { ...own };
  for (const token of Object.keys(own)) {
    const candidate: Record<string, string> = { ...minimal };
    delete candidate[token];
    let values: Readonly<Record<string, string>>;
    try {
      values = resolveTokens({ ...baseline, ...candidate }).values;
    } catch {
      continue;
    }
    if (DESIGN_TOKENS.every((name) => values[name] === target[name])) delete minimal[token];
  }
  return minimal;
}

function swatchName(value: string, palette: Readonly<Record<string, string>>, used: Set<string>): string | undefined {
  return Object.keys(palette)
    .sort()
    .find((name) => !used.has(name) && palette[name] === value);
}

/** Write statements back into the nested shape a theme file uses, in graph order. */
function toDefinition(definition: ThemeDefinition, statements: Readonly<Record<string, string>>, palette: Readonly<Record<string, string>>): ThemeDefinition {
  const used = new Set<string>();
  const value = (name: string): ThemeColorValue => {
    const literal = statements[name]!;
    const swatch = swatchName(literal, palette, used);
    if (swatch === undefined) return literal;
    used.add(swatch);
    return { palette: swatch };
  };
  const group = (namespace: string) => {
    const nested: Record<string, ThemeColorValue> = {};
    for (const token of DESIGN_TOKENS) {
      if (!token.startsWith(`${namespace}.`)) continue;
      if (statements[token] === undefined) continue;
      nested[token.slice(namespace.length + 1)] = value(token);
    }
    return nested;
  };
  const kept = Object.keys(palette)
    .sort()
    .reduce<Record<string, string>>((swatches, name) => (used.has(name) ? { ...swatches, [name]: palette[name]! } : swatches), {});
  return {
    id: definition.id,
    name: definition.name,
    colorScheme: definition.colorScheme,
    ...(definition.extends ? { extends: definition.extends } : {}),
    ...(Object.keys(kept).length > 0 ? { palette: kept } : {}),
    ui: group('ui') as ThemeDefinition['ui'],
    editor: {
      surface: group('editor.surface') as ThemeDefinition['editor']['surface'],
      syntax: group('editor.syntax') as ThemeDefinition['editor']['syntax'],
      terminal: group('editor.terminal') as ThemeDefinition['editor']['terminal'],
    },
  };
}

/** Rewrite a theme file into the smallest form that resolves to the same palette. */
export function normalizeThemeFile(raw: string, options: ThemeNormalizeOptions = {}): ThemeNormalizeResult {
  const path = options.path ?? '<theme file>';
  const parsed = parseThemeFile(raw, path);
  if (!parsed.valid) return { text: raw, changed: false, themes: [], profiles: {}, diagnostics: parsed.diagnostics };

  const sources = [
    ...(options.builtinThemes ?? []).map((definition) => ({ definition, source: 'builtin' as const, path: '<builtin>' })),
    ...parsed.definitions.map((definition) => ({ definition, source: 'user' as const, path })),
  ];
  const resolution = resolveThemeDefinitions(sources);
  const themes: ThemeDefinition[] = [];
  const profiles: Record<string, ThemeProfile> = {};
  const diagnostics: ThemeDiagnostic[] = [...parsed.diagnostics, ...resolution.diagnostics];
  const seen = new Set<string>();

  for (const definition of parsed.definitions) {
    if (seen.has(definition.id)) continue;
    seen.add(definition.id);
    const statements = resolution.statements.get(definition.id);
    if (!statements || !resolution.themes.some((theme) => theme.id === definition.id)) continue;
    const own = resolvedOwn(statements);
    const baseline = resolvedBaseline(definition.extends ? resolution.statements.get(definition.extends) : undefined);
    const minimal = minimize(own, baseline);
    const normalized = toDefinition(definition, minimal, definition.palette ?? {});
    themes.push(normalized);
    profiles[definition.id] = themeProfile(minimal);
  }

  if (diagnostics.length > 0) return { text: raw, changed: false, themes: [], profiles: {}, diagnostics };
  const text = `${JSON.stringify({ version: 1, themes }, null, 2)}\n`;
  return { text, changed: text !== raw, themes, profiles, diagnostics };
}
