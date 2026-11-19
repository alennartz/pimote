import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../shared/test/theme-fixtures.js';
import { auditThemes, formatThemeAudit } from './theme-audit.js';

describe('theme audit', () => {
  it('reports pair and highlighted-background violations with their relationships', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#ffffff';
    theme.editor.surface.foreground = '#000000';
    theme.editor.surface.selection = '#ffffff';
    theme.editor.syntax.variable = '#ffffff';
    theme.editor.syntax.inserted = '#ffffff';
    theme.ui.muted = '#ffffff';
    theme.ui['muted-foreground'] = '#ffffff';

    const report = auditThemes([theme]);
    const rules = report.findings.map((finding) => `${finding.rule}:${finding.relationship}`);

    expect(rules).toContain('editor.syntax.variable:variable on selection');
    expect(report.findings.some((finding) => finding.rule === 'editor.syntax.variable' && finding.relation === 'triple')).toBe(true);
    expect(rules).toContain('editor.diff.inserted:inserted on editor background');
    expect(rules).toContain('ui.muted:muted-foreground on muted');
    expect(report.errorCount).toBeGreaterThan(0);
    expect(formatThemeAudit(report)).toContain('test/light');
  });

  it('does not report a readable semantic triple', () => {
    const theme = resolvedTheme('test/light');
    theme.editor.surface.background = '#ffffff';
    theme.editor.surface.foreground = '#000000';
    theme.editor.surface.selection = '#dddddd';
    theme.editor.syntax.variable = '#000000';

    const report = auditThemes([theme]);

    expect(report.findings.some((finding) => finding.rule === 'editor.syntax.variable')).toBe(false);
  });
});
