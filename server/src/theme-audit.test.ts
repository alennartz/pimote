import { describe, expect, it } from 'vitest';
import { resolvedTheme } from '../../shared/test/theme-fixtures.js';
import { auditClientMappings, auditThemes, formatThemeAudit } from './theme-audit.js';

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

  it('flags diff CSS without dedicated diff background roles', () => {
    expect(auditClientMappings('.hljs-addition { background: var(--pimote-editor-active-line); }')).toEqual([
      expect.objectContaining({ rule: 'mapping.editor.diff.addition-background' }),
      expect.objectContaining({ rule: 'mapping.editor.diff.deletion-background' }),
    ]);
    expect(auditClientMappings('--pimote-editor-diff-addition-background: #dafbe1; --pimote-editor-diff-deletion-background: #ffebe9;')).toEqual([]);
  });
});
