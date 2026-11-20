import Color from 'colorjs.io';
import type { EditorSyntaxRole, ResolvedTheme, UiColorToken } from '../../shared/dist/index.js';

export type ThemeAuditSeverity = 'warning' | 'error';
export type ThemeAuditRelation = 'pair' | 'triple';

export interface ThemeMappingFinding {
  rule: string;
  path: string;
  message: string;
  severity: ThemeAuditSeverity;
}

export interface ThemeAuditFinding {
  themeId: string;
  themeName: string;
  rule: string;
  relation: ThemeAuditRelation;
  relationship: string;
  ratio: number;
  minimum: number;
  foreground: string;
  background: string;
  severity: ThemeAuditSeverity;
}

export interface ThemeAuditReport {
  themeCount: number;
  findings: ThemeAuditFinding[];
  warningCount: number;
  errorCount: number;
}

// These rules describe current component pairings. A token name alone does not create a contrast contract.
const UI_PAIR_RULES: ReadonlyArray<{
  rule: string;
  relationship: string;
  foreground: UiColorToken;
  background: UiColorToken;
  minimum: number;
}> = [
  { rule: 'ui.background', relationship: 'foreground on background', foreground: 'foreground', background: 'background', minimum: 4.5 },
  { rule: 'ui.card', relationship: 'card-foreground on card', foreground: 'card-foreground', background: 'card', minimum: 4.5 },
  { rule: 'ui.popover', relationship: 'popover-foreground on popover', foreground: 'popover-foreground', background: 'popover', minimum: 4.5 },
  { rule: 'ui.primary', relationship: 'primary-foreground on primary', foreground: 'primary-foreground', background: 'primary', minimum: 4.5 },
  { rule: 'ui.secondary', relationship: 'secondary-foreground on secondary', foreground: 'secondary-foreground', background: 'secondary', minimum: 4.5 },
  { rule: 'ui.muted', relationship: 'muted-foreground on muted', foreground: 'muted-foreground', background: 'muted', minimum: 3 },
  { rule: 'ui.accent', relationship: 'accent-foreground on accent', foreground: 'accent-foreground', background: 'accent', minimum: 4.5 },
  { rule: 'ui.sidebar', relationship: 'sidebar-foreground on sidebar', foreground: 'sidebar-foreground', background: 'sidebar', minimum: 4.5 },
  {
    rule: 'ui.sidebar-primary',
    relationship: 'sidebar-primary-foreground on sidebar-primary',
    foreground: 'sidebar-primary-foreground',
    background: 'sidebar-primary',
    minimum: 4.5,
  },
  { rule: 'ui.sidebar-accent', relationship: 'sidebar-accent-foreground on sidebar-accent', foreground: 'sidebar-accent-foreground', background: 'sidebar-accent', minimum: 4.5 },
  { rule: 'ui.avatar', relationship: 'avatar-fg on avatar-bg', foreground: 'avatar-fg', background: 'avatar-bg', minimum: 3 },
  { rule: 'ui.link-background', relationship: 'link on background', foreground: 'link', background: 'background', minimum: 4.5 },
  { rule: 'ui.link-sunken', relationship: 'link on surface-sunken', foreground: 'link', background: 'surface-sunken', minimum: 4.5 },
];

const STATUS_TEXT_ROLES: ReadonlyArray<{ role: UiColorToken; label: string }> = [
  { role: 'status-active', label: 'active' },
  { role: 'status-streaming', label: 'streaming' },
  { role: 'status-connected', label: 'connected' },
  { role: 'status-error', label: 'error' },
  { role: 'status-reconnecting', label: 'reconnecting' },
];

const DIFF_ROLES: ReadonlyArray<{ role: EditorSyntaxRole; label: string; background?: 'addition' | 'deletion' }> = [
  { role: 'inserted', label: 'inserted', background: 'addition' },
  { role: 'deleted', label: 'deleted', background: 'deletion' },
  { role: 'changed', label: 'changed' },
];

const COLOR_SPACE = 'oklch';
const STATUS_TINT_AMOUNT = 0.1;
const ANSI_TEXT_MINIMUM = 2;

const DIFF_MAPPING_CONTRACTS = [
  { rule: 'mapping.editor.diff.addition-background', token: '--pimote-editor-diff-addition-background' },
  { rule: 'mapping.editor.diff.deletion-background', token: '--pimote-editor-diff-deletion-background' },
] as const;

export function auditClientMappings(highlightThemeCss: string): ThemeMappingFinding[] {
  return DIFF_MAPPING_CONTRACTS.filter(({ token }) => !highlightThemeCss.includes(token)).map(({ rule, token }) => ({
    rule,
    path: 'client/src/lib/highlight-theme.css',
    message: `diff background must use the dedicated ${token} role`,
    severity: 'error' as const,
  }));
}

type ThreeCoordinates = [number, number, number];

function coordinates(color: Color): ThreeCoordinates {
  const [first, second, third] = color.coords;
  return [first ?? 0, second ?? 0, third ?? 0];
}

function opaqueColor(value: string, backdrop: Color | string = '#000000'): Color {
  const color = new Color(value).to('srgb');
  const alpha = color.alpha ?? 1;
  const colorCoords = coordinates(color);
  if (alpha >= 1) return new Color('srgb', colorCoords);
  const base = typeof backdrop === 'string' ? opaqueColor(backdrop) : backdrop.to('srgb');
  const baseCoords = coordinates(base);
  return new Color('srgb', colorCoords.map((channel, index) => channel * alpha + baseCoords[index] * (1 - alpha)) as ThreeCoordinates);
}

function contrastRatio(foreground: string, background: string, backdrop: string): number {
  const opaqueBackground = opaqueColor(background, backdrop);
  const opaqueForeground = opaqueColor(foreground, opaqueBackground);
  return opaqueForeground.contrast(opaqueBackground, 'WCAG21');
}

function mixOklch(base: string, overlay: string, amount: number): string {
  const baseColor = new Color(base).to(COLOR_SPACE);
  const overlayColor = new Color(overlay).to(COLOR_SPACE);
  const baseCoords = coordinates(baseColor);
  const overlayCoords = coordinates(overlayColor);
  return new Color(COLOR_SPACE, baseCoords.map((channel, index) => channel * (1 - amount) + overlayCoords[index] * amount) as ThreeCoordinates).toString();
}

function severityFor(ratio: number, minimum: number): ThemeAuditSeverity {
  return ratio < 3 || minimum < 3 ? 'error' : 'warning';
}

function addFinding(
  findings: ThemeAuditFinding[],
  theme: ResolvedTheme,
  rule: string,
  relation: ThemeAuditRelation,
  relationship: string,
  foreground: string,
  background: string,
  backdrop: string,
  minimum: number,
): void {
  const ratio = contrastRatio(foreground, background, backdrop);
  if (ratio >= minimum) return;
  findings.push({
    themeId: theme.id,
    themeName: theme.name,
    rule,
    relation,
    relationship,
    ratio,
    minimum,
    foreground,
    background,
    severity: severityFor(ratio, minimum),
  });
}

function auditPair(
  findings: ThemeAuditFinding[],
  theme: ResolvedTheme,
  rule: string,
  relationship: string,
  foreground: string,
  background: string,
  minimum: number,
  backdrop: string,
): void {
  addFinding(findings, theme, rule, 'pair', relationship, foreground, background, backdrop, minimum);
}

function auditSyntax(findings: ThemeAuditFinding[], theme: ResolvedTheme, role: EditorSyntaxRole): void {
  const foreground = theme.editor.syntax[role];
  const editorBackground = theme.editor.surface.background;
  auditPair(findings, theme, `editor.syntax.${role}`, `${role} on editor background`, foreground, editorBackground, 3, editorBackground);
}

function auditTheme(theme: ResolvedTheme): ThemeAuditFinding[] {
  const findings: ThemeAuditFinding[] = [];
  const surface = theme.editor.surface;
  const syntax = theme.editor.syntax;
  const ui = theme.ui;

  auditPair(findings, theme, 'editor.body', 'editor foreground on background', surface.foreground, surface.background, 4.5, surface.background);
  auditPair(findings, theme, 'editor.selection', 'selection foreground on selection', surface['selection-foreground'], surface.selection, 4.5, surface.background);
  auditPair(findings, theme, 'editor.matching-bracket', 'bracket syntax on matching bracket', syntax.bracket, surface['matching-bracket'], 3, surface.background);
  auditPair(findings, theme, 'editor.search-match-marker', 'search-match marker on editor background', surface['search-match'], surface.background, 3, surface.background);

  for (const role of Object.keys(syntax) as EditorSyntaxRole[]) auditSyntax(findings, theme, role);

  for (const { role, label, background } of DIFF_ROLES) {
    const foreground = syntax[role];
    auditPair(findings, theme, `editor.diff.${label}`, `${label} on editor background`, foreground, surface.background, 4.5, surface.background);
    if (background) {
      const diffBackground = background === 'addition' ? surface['diff-addition-background'] : surface['diff-deletion-background'];
      auditPair(findings, theme, `editor.diff.${label}`, `${label} on ${background} diff surface`, foreground, diffBackground, 4.5, surface.background);
    }
  }

  for (const rule of UI_PAIR_RULES) {
    auditPair(findings, theme, rule.rule, rule.relationship, ui[rule.foreground], ui[rule.background], rule.minimum, ui.background);
  }

  auditPair(
    findings,
    theme,
    'ui.error-callout',
    'error-foreground on assistant error surface',
    ui['error-foreground'],
    mixOklch(ui.background, ui['error-surface'], 0.55),
    4.5,
    ui.background,
  );
  auditPair(
    findings,
    theme,
    'ui.skill-callout',
    'skill-foreground on skill surface',
    ui['skill-foreground'],
    mixOklch(ui.background, ui['skill-surface'], 0.5),
    4.5,
    ui.background,
  );
  auditPair(
    findings,
    theme,
    'ui.custom-callout',
    'custom-foreground on custom surface',
    ui['custom-foreground'],
    mixOklch(ui.background, ui['custom-surface'], 0.5),
    4.5,
    ui.background,
  );
  auditPair(findings, theme, 'ui.link-skill', 'link on skill surface', ui.link, mixOklch(ui.background, ui['skill-surface'], 0.5), 4.5, ui.background);
  auditPair(findings, theme, 'ui.link-custom', 'link on custom surface', ui.link, mixOklch(ui.background, ui['custom-surface'], 0.5), 4.5, ui.background);
  for (const { role, label } of STATUS_TEXT_ROLES) {
    const tintedSurface = mixOklch(ui.background, ui[role], STATUS_TINT_AMOUNT);
    auditPair(findings, theme, `ui.status.${label}`, `foreground on ${label} status tint`, ui.foreground, tintedSurface, 4.5, ui.background);
  }

  const terminalSurfaces = [
    ['bash', mixOklch(ui.background, ui['skill-surface'], 0.52)],
    ['extension-status', mixOklch(ui.background, ui.muted, 0.5)],
  ] as const;
  for (const [context, background] of terminalSurfaces) {
    for (const [role, foreground] of Object.entries(theme.editor.terminal) as Array<[string, string]>) {
      auditPair(findings, theme, `terminal.${context}.${role}`, `${role} on ${context} background`, foreground, background, ANSI_TEXT_MINIMUM, ui.background);
    }
  }

  return findings;
}

export function auditThemes(themes: readonly ResolvedTheme[]): ThemeAuditReport {
  const findings = themes.flatMap((theme) => auditTheme(theme));
  return {
    themeCount: themes.length,
    findings,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
    errorCount: findings.filter((finding) => finding.severity === 'error').length,
  };
}

export function formatThemeAudit(report: ThemeAuditReport): string {
  const lines = [
    `Theme contrast audit: ${report.themeCount} theme${report.themeCount === 1 ? '' : 's'}`,
    `Violations: ${report.errorCount} errors, ${report.warningCount} warnings`,
  ];
  if (report.findings.length === 0) return [...lines, 'No contrast violations.'].join('\n');

  const byTheme = new Map<string, ThemeAuditFinding[]>();
  for (const finding of report.findings) {
    const themeFindings = byTheme.get(finding.themeId) ?? [];
    themeFindings.push(finding);
    byTheme.set(finding.themeId, themeFindings);
  }
  for (const findings of byTheme.values()) {
    lines.push('', `${findings[0].themeName} (${findings[0].themeId})`);
    for (const finding of findings) {
      lines.push(`  ${finding.severity.toUpperCase()} ${finding.rule}: ${finding.relationship} is ${finding.ratio.toFixed(2)}:1 (minimum ${finding.minimum.toFixed(1)}:1)`);
    }
  }
  return lines.join('\n');
}
