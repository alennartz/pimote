import {
  ANSI_COLOR_NAMES,
  EDITOR_SURFACE_ROLES,
  REQUIRED_SYNTAX_ROOTS,
  SYNTAX_CHILDREN,
  SYNTAX_SCOPES,
  UI_COLOR_TOKENS,
  syntaxScopeRoot,
  type AnsiColorName,
  type EditorSurfaceRole,
  type SyntaxScope,
  type UiColorToken,
} from './themes.js';

/** The four namespaces a design token belongs to. */
export type TokenNamespace = 'ui' | 'editor.surface' | 'editor.syntax' | 'editor.terminal';

const NAMESPACES: readonly TokenNamespace[] = ['ui', 'editor.surface', 'editor.syntax', 'editor.terminal'];

/** A qualified design token name, such as `ui.card` or `editor.terminal.bright-red`. */
export type UiDesignToken = `ui.${UiColorToken}`;
export type SurfaceDesignToken = `editor.surface.${EditorSurfaceRole}`;
export type SyntaxDesignToken = `editor.syntax.${SyntaxScope}`;
export type TerminalDesignToken = `editor.terminal.${AnsiColorName}`;
export type DesignToken = UiDesignToken | SurfaceDesignToken | SyntaxDesignToken | TerminalDesignToken;

/** Every design token the catalog resolves, in namespace order. */
export const DESIGN_TOKENS: readonly DesignToken[] = [
  ...UI_COLOR_TOKENS.map((token): UiDesignToken => `ui.${token}`),
  ...EDITOR_SURFACE_ROLES.map((token): SurfaceDesignToken => `editor.surface.${token}`),
  ...SYNTAX_SCOPES.map((token): SyntaxDesignToken => `editor.syntax.${token}`),
  ...ANSI_COLOR_NAMES.map((token): TerminalDesignToken => `editor.terminal.${token}`),
];

/**
 * Tokens no other token can stand in for. A theme must state each one, or inherit it from a base theme.
 * Aliasing any of them would change what the role means: a shadow is not a border, and a code palette
 * with no syntax color is not a code palette.
 */
export const MANDATORY_TOKENS: readonly DesignToken[] = [
  'ui.background',
  'ui.foreground',
  'ui.primary',
  'ui.primary-foreground',
  'ui.border',
  'ui.destructive',
  'ui.warning',
  'ui.warning-foreground',
  'ui.status-connected',
  'ui.status-streaming-on-primary',
  'ui.status-reconnecting-on-primary',
  'ui.shadow-color',
  'editor.surface.background',
  'editor.surface.foreground',
  'editor.surface.diff-addition-background',
  'editor.surface.diff-deletion-background',
  ...REQUIRED_SYNTAX_ROOTS.map((root): SyntaxDesignToken => `editor.syntax.${root}`),
  ...ANSI_COLOR_NAMES.filter((name) => !name.startsWith('bright-')).map((name): TerminalDesignToken => `editor.terminal.${name}`),
];

/**
 * The fallback graph: each token names the token that stands in when a theme states no value.
 *
 * An edge states that the token is a more specific statement of the same intent. Depth measures that
 * specificity, from the anchors above down through paired slots, component surfaces, component states,
 * and nested refinements. Every chain ends at a mandatory token, and the graph holds no cycles.
 */
export const TOKEN_FALLBACKS: Readonly<Partial<Record<DesignToken, DesignToken>>> = {
  // Text and paired slots: the least specific statement of a foreground or a surface.
  'ui.card': 'ui.background',
  'ui.card-foreground': 'ui.foreground',
  'ui.popover': 'ui.card',
  'ui.popover-foreground': 'ui.foreground',
  'ui.secondary': 'ui.card',
  'ui.secondary-foreground': 'ui.foreground',
  'ui.muted': 'ui.card',
  'ui.muted-foreground': 'ui.foreground',
  'ui.input': 'ui.border',
  'ui.ring': 'ui.primary',
  'ui.link': 'ui.primary',
  'ui.link-hover': 'ui.link',

  // The surface ladder: each rung refines the one before it.
  'ui.surface-sunken': 'ui.background',
  'ui.surface-raised': 'ui.card',
  'ui.surface-subtle': 'ui.card',
  'ui.surface-hover': 'ui.surface-subtle',
  'ui.accent': 'ui.surface-hover',
  'ui.accent-foreground': 'ui.foreground',

  // Sidebar surfaces shadow the main surfaces.
  'ui.sidebar': 'ui.card',
  'ui.sidebar-foreground': 'ui.foreground',
  'ui.sidebar-primary': 'ui.primary',
  'ui.sidebar-primary-foreground': 'ui.primary-foreground',
  'ui.sidebar-accent': 'ui.accent',
  'ui.sidebar-accent-foreground': 'ui.accent-foreground',
  'ui.sidebar-border': 'ui.border',
  'ui.sidebar-ring': 'ui.ring',

  // Status roles reuse the semantic anchors.
  'ui.status-active': 'ui.primary',
  'ui.status-streaming': 'ui.status-connected',
  'ui.status-error': 'ui.destructive',
  'ui.status-reconnecting': 'ui.warning',

  // Callout families reuse a status accent and a subtle surface.
  'ui.error-accent': 'ui.destructive',
  'ui.error-surface': 'ui.surface-subtle',
  'ui.error-foreground': 'ui.foreground',
  'ui.error-avatar-fg': 'ui.error-foreground',
  'ui.skill-accent': 'ui.status-connected',
  'ui.skill-surface': 'ui.surface-subtle',
  'ui.skill-foreground': 'ui.foreground',
  'ui.skill-foreground-hover': 'ui.skill-foreground',
  'ui.bash-accent': 'ui.status-connected',
  'ui.custom-accent': 'ui.primary',
  'ui.custom-surface': 'ui.surface-subtle',
  'ui.custom-foreground': 'ui.foreground',
  'ui.custom-foreground-hover': 'ui.custom-foreground',

  // Identity marks follow the accent.
  'ui.avatar-bg': 'ui.muted',
  'ui.avatar-fg': 'ui.muted-foreground',

  // No categorical ramp exists among the anchors, so an unstated chart draws in the accent color.
  'ui.chart-1': 'ui.primary',
  'ui.chart-2': 'ui.primary',
  'ui.chart-3': 'ui.primary',
  'ui.chart-4': 'ui.primary',
  'ui.chart-5': 'ui.primary',

  // Editor surfaces borrow the dashboard accent where they mark a selection or a state.
  'editor.surface.selection': 'ui.primary',
  'editor.surface.selection-foreground': 'ui.primary-foreground',
  'editor.surface.cursor': 'ui.foreground',
  'editor.surface.active-line': 'ui.surface-hover',
  'editor.surface.gutter-background': 'editor.surface.background',
  'editor.surface.gutter-foreground': 'ui.muted-foreground',
  'editor.surface.line-number': 'ui.muted-foreground',
  'editor.surface.active-line-number': 'editor.surface.line-number',
  'editor.surface.matching-bracket': 'ui.ring',
  'editor.surface.search-match': 'ui.warning',

  // Structure takes the editor foreground, and every child scope takes its root.
  'editor.syntax.meta': 'editor.surface.foreground',
  ...syntaxChildFallbacks(),

  // A bright ANSI slot refines its base slot.
  ...brightTerminalFallbacks(),
};

function syntaxChildFallbacks(): Readonly<Record<string, SyntaxDesignToken>> {
  return Object.fromEntries(SYNTAX_CHILDREN.map((scope) => [`editor.syntax.${scope}`, `editor.syntax.${syntaxScopeRoot(scope)}` as SyntaxDesignToken]));
}

function brightTerminalFallbacks(): Readonly<Record<string, TerminalDesignToken>> {
  return Object.fromEntries(
    ANSI_COLOR_NAMES.filter((name) => name.startsWith('bright-')).map((name) => [
      `editor.terminal.${name}`,
      `editor.terminal.${name.slice('bright-'.length)}` as TerminalDesignToken,
    ]),
  );
}

/** How a resolved token got its value. */
export type TokenProvenance = { kind: 'explicit' } | { kind: 'fallback'; via: readonly DesignToken[] };

/** Every token's value, plus the statement or chain that supplied it. */
export interface TokenResolution {
  values: Readonly<Record<DesignToken, string>>;
  provenance: Readonly<Record<DesignToken, TokenProvenance>>;
}

/** A theme's stated token values, keyed by qualified token name. */
export type TokenStatements = Readonly<Partial<Record<DesignToken, string>>>;

/** A fallback graph, built from token names, the mandatory subset, and one edge per alias. */
export interface TokenGraphSpec {
  tokens: readonly string[];
  mandatory: readonly string[];
  fallbacks: Readonly<Partial<Record<string, string>>>;
}

/** A validated fallback graph. */
export interface TokenGraph {
  tokens: readonly string[];
  mandatory: readonly string[];
  fallbacks: Readonly<Partial<Record<string, string>>>;
  /** Edges between a token and its nearest mandatory token. */
  depth(token: string): number;
  resolve(statements: Readonly<Record<string, string | undefined>>): TokenResolution;
}

/** Build a fallback graph, rejecting a malformed graph before any theme uses it. */
export function createTokenGraph(spec: TokenGraphSpec): TokenGraph {
  const tokens = new Set(spec.tokens);
  const mandatory = new Set(spec.mandatory);
  for (const token of spec.mandatory) if (!tokens.has(token)) throw new Error(`mandatory token ${token} is not declared`);
  for (const [token, target] of Object.entries(spec.fallbacks)) {
    if (target === undefined) continue;
    if (!tokens.has(token)) throw new Error(`fallback source ${token} is not declared`);
    if (!tokens.has(target)) throw new Error(`fallback target ${target} is not declared`);
    if (mandatory.has(token)) throw new Error(`mandatory token ${token} must not declare a fallback`);
  }
  for (const token of spec.tokens) if (!mandatory.has(token) && !(token in spec.fallbacks)) throw new Error(`token ${token} is neither mandatory nor aliased`);

  const depths = new Map<string, number>();
  const depth = (token: string, visited: readonly string[] = []): number => {
    const known = depths.get(token);
    if (known !== undefined) return known;
    if (visited.includes(token)) throw new Error(`token fallback cycle: ${[...visited, token].join(' -> ')}`);
    const target = spec.fallbacks[token];
    const value = target === undefined ? 0 : depth(target, [...visited, token]) + 1;
    depths.set(token, value);
    return value;
  };
  for (const token of spec.tokens) depth(token);

  return {
    tokens: spec.tokens,
    mandatory: spec.mandatory,
    fallbacks: spec.fallbacks,
    depth: (token) => {
      const value = depths.get(token);
      if (value === undefined) throw new Error(`${token} is not a design token`);
      return value;
    },
    resolve: (statements) => {
      for (const token of Object.keys(statements)) if (!tokens.has(token)) throw new Error(`${token} is not a design token`);
      const values: Record<string, string> = {};
      const provenance: Record<string, TokenProvenance> = {};
      const resolveToken = (token: string, visited: readonly string[]): string => {
        const known = values[token];
        if (known !== undefined) return known;
        const stated = statements[token];
        if (stated !== undefined) {
          values[token] = stated;
          provenance[token] = { kind: 'explicit' };
          return stated;
        }
        const target = spec.fallbacks[token];
        if (target === undefined) throw new Error(`no value for mandatory token ${token}`);
        if (visited.includes(token)) throw new Error(`token fallback cycle: ${[...visited, token].join(' -> ')}`);
        const value = resolveToken(target, [...visited, token]);
        const inherited = provenance[target];
        values[token] = value;
        provenance[token] = { kind: 'fallback', via: [target, ...(inherited?.kind === 'fallback' ? inherited.via : [])] as DesignToken[] };
        return value;
      };
      for (const token of spec.tokens) resolveToken(token, []);
      return { values: values as Record<DesignToken, string>, provenance: provenance as Record<DesignToken, TokenProvenance> };
    },
  };
}

/** The shipped fallback graph. */
export const designTokenGraph: TokenGraph = createTokenGraph({ tokens: DESIGN_TOKENS, mandatory: MANDATORY_TOKENS, fallbacks: TOKEN_FALLBACKS });

/** Resolve stated values into every token value. */
export function resolveTokens(statements: TokenStatements): TokenResolution {
  return designTokenGraph.resolve(statements);
}

/** Edges between a token and its nearest mandatory token. */
export function tokenDepth(token: DesignToken): number {
  return designTokenGraph.depth(token);
}

/** The namespace a qualified token belongs to. */
export function tokenNamespace(token: DesignToken): TokenNamespace {
  const namespace = NAMESPACES.find((candidate) => token.startsWith(`${candidate}.`));
  if (!namespace) throw new Error(`${token} is not a design token`);
  return namespace;
}

/** The token name without its namespace. */
export function tokenName(token: DesignToken): string {
  return token.slice(tokenNamespace(token).length + 1);
}

/** Every token in one namespace, in graph order. */
export function tokensInNamespace(namespace: TokenNamespace): readonly DesignToken[] {
  return DESIGN_TOKENS.filter((token) => token.startsWith(`${namespace}.`));
}

/** Stated values grouped by namespace, as a theme file presents them. */
export interface NamespacedTokenStatements {
  ui?: Readonly<Record<string, string>>;
  'editor.surface'?: Readonly<Record<string, string>>;
  'editor.syntax'?: Readonly<Record<string, string>>;
  'editor.terminal'?: Readonly<Record<string, string>>;
}

/** Flatten namespace-keyed statements into qualified token names. */
export function qualifyTokenStatements(statements: NamespacedTokenStatements): Record<string, string> {
  const qualified: Record<string, string> = {};
  for (const namespace of NAMESPACES) for (const [name, value] of Object.entries(statements[namespace] ?? {})) qualified[`${namespace}.${name}`] = value;
  return qualified;
}

/** How far a theme's own statements reach into the graph, per namespace. */
export interface ThemeProfile {
  /** The deepest stated token per namespace. Anchor-only themes report zero for every namespace. */
  depth: Readonly<Record<TokenNamespace, number>>;
  /** Stated tokens per namespace and depth. */
  histogram: Readonly<Record<TokenNamespace, readonly number[]>>;
  /** Stated tokens whose fallback parent the theme leaves unstated. */
  reach: readonly DesignToken[];
}

/** Summarize the statements that survive normalization. */
export function themeProfile(statements: TokenStatements): ThemeProfile {
  const depth = Object.fromEntries(NAMESPACES.map((namespace) => [namespace, 0])) as Record<TokenNamespace, number>;
  const histogram = Object.fromEntries(NAMESPACES.map((namespace) => [namespace, [] as number[]])) as Record<TokenNamespace, number[]>;
  const reach: DesignToken[] = [];
  const mandatory = new Set(MANDATORY_TOKENS);
  for (const token of DESIGN_TOKENS) {
    if (statements[token] === undefined) continue;
    const namespace = tokenNamespace(token);
    const edges = tokenDepth(token);
    depth[namespace] = Math.max(depth[namespace]!, edges);
    histogram[namespace]![edges] = (histogram[namespace]![edges] ?? 0) + 1;
    if (!mandatory.has(token) && statements[TOKEN_FALLBACKS[token]!] === undefined) reach.push(token);
  }
  return { depth, histogram, reach };
}
