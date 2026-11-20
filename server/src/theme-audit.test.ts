import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../shared/test/theme-fixtures.js';
import { auditClientMappings, auditThemes, formatThemeAudit } from './theme-audit.js';

describe('theme audit', () => {
  it('reports pair violations with their relationships', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#ffffff';
    theme.editor.surface.foreground = '#000000';
    theme.editor.surface.selection = '#ffffff';
    theme.editor.surface['selection-foreground'] = '#ffffff';
    theme.editor.syntax.variable = '#ffffff';
    theme.editor.syntax.inserted = '#ffffff';
    theme.ui.muted = '#ffffff';
    theme.ui['muted-foreground'] = '#ffffff';

    const report = auditThemes([theme]);
    const rules = report.findings.map((finding) => `${finding.rule}:${finding.relationship}`);

    expect(rules).toContain('editor.selection:selection foreground on selection');
    expect(rules).toContain('editor.diff.inserted:inserted on editor background');
    expect(rules).toContain('ui.muted:muted-foreground on muted');
    expect(report.errorCount).toBeGreaterThan(0);
    expect(formatThemeAudit(report)).toContain('test/light');
  });

  it('does not report readable editor and selection colors', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#ffffff';
    theme.editor.surface.foreground = '#000000';
    theme.editor.surface.selection = '#dddddd';
    theme.editor.syntax.variable = '#000000';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'editor.syntax.variable')).toBe(false);
  });

  it('checks editor text on the sunken code and diff surface', () => {
    const theme = resolvedTheme('test/light');
    theme.ui['surface-sunken'] = '#ffffff';
    theme.editor.surface.foreground = '#ffffff';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'editor.code-surface')).toBe(true);
  });

  it('checks alpha diff highlights against the editor background', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#2D353B';
    theme.editor.surface['diff-addition-background'] = '#42504733';
    theme.editor.surface['diff-deletion-background'] = '#51404533';

    const findings = auditThemes([theme]).findings.filter(({ rule }) => rule.startsWith('editor.diff-background.'));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'editor.diff-background.addition', minimum: 1.2, severity: 'error' }),
        expect.objectContaining({ rule: 'editor.diff-background.deletion', minimum: 1.2, severity: 'error' }),
      ]),
    );
  });

  it('accepts diff highlights with 1.2:1 separation from the editor background', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#000000';
    theme.editor.surface['diff-addition-background'] = '#1A1A1A';
    theme.editor.surface['diff-deletion-background'] = '#1A1A1A';

    const findings = auditThemes([theme]).findings.filter(({ rule }) => rule.startsWith('editor.diff-background.'));

    expect(findings).toEqual([]);
  });

  it('does not invent text contracts for accent tokens without a paired consumer', () => {
    const theme = resolvedTheme('test/light');
    theme.ui.background = '#ffffff';
    theme.ui.destructive = '#ffffff';
    theme.ui.warning = '#ffffff';
    theme.ui['warning-foreground'] = '#ffffff';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'ui.destructive')).toBe(false);
    expect(report.findings.some((finding) => finding.rule === 'ui.warning')).toBe(false);
  });

  it('checks ANSI colors against both terminal output surfaces', () => {
    const theme = resolvedTheme('test/light');
    theme.ui.background = '#ffffff';
    theme.ui['skill-surface'] = '#ffffff';
    theme.ui.muted = '#ffffff';
    theme.editor.terminal.red = '#ffffff';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'terminal.bash.red')).toBe(true);
    expect(report.findings.some((finding) => finding.rule === 'terminal.extension-status.red')).toBe(true);
  });

  it('checks streaming and needs-attention icons on selected session chips', () => {
    const theme = resolvedTheme('test/light');
    theme.ui.primary = '#ffffff';
    theme.ui['status-streaming'] = '#ffffff';
    theme.ui['status-reconnecting'] = '#ffffff';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'ui.session-chip.streaming')).toBe(true);
    expect(report.findings.some((finding) => finding.rule === 'ui.session-chip.needs-attention')).toBe(true);
  });

  it('checks hover surfaces for menus and buttons', () => {
    const theme = resolvedTheme('test/light');
    theme.ui.background = '#ffffff';
    theme.ui.popover = '#ffffff';
    theme.ui.accent = '#ffffff';
    theme.ui.primary = '#ffffff';
    theme.ui.secondary = '#ffffff';
    theme.ui['surface-hover'] = '#ffffff';
    theme.ui.muted = '#ffffff';

    const report = auditThemes([theme]);
    const rules = report.findings.map((finding) => finding.rule);

    expect(rules).toContain('ui.menu-item-hover');
    expect(rules).toContain('ui.button.primary-hover');
    expect(rules).toContain('ui.button.secondary-hover');
    expect(rules).toContain('ui.button.ghost-hover');
    expect(rules).toContain('ui.button.outline-hover');
  });

  it('accepts a menu hover surface at the 1.2:1 minimum', () => {
    const theme = resolvedTheme('test/light');
    theme.ui.popover = '#000000';
    theme.ui.accent = '#202020';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'ui.menu-item-hover')).toBe(false);
  });

  it('flags diff CSS without dedicated diff background roles', () => {
    expect(auditClientMappings('.hljs-addition { background: var(--pimote-editor-active-line); }')).toEqual([
      expect.objectContaining({ rule: 'mapping.editor.diff.addition-background' }),
      expect.objectContaining({ rule: 'mapping.editor.diff.deletion-background' }),
    ]);
    expect(auditClientMappings('--pimote-editor-diff-addition-background: #dafbe1; --pimote-editor-diff-deletion-background: #ffebe9;')).toEqual([]);
  });
});
