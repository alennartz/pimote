import { describe, expect, it } from 'vitest';
import { applyAppNameToHtml, applyAppNameToManifest, resolveAppName, setMetaContent } from './branding.js';

describe('resolveAppName', () => {
  it('uses the configured name', () => {
    expect(resolveAppName({ appName: 'Desk Pi' })).toBe('Desk Pi');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveAppName({ appName: '  Desk Pi  ' })).toBe('Desk Pi');
  });

  it('falls back to the default when absent or blank', () => {
    expect(resolveAppName({})).toBe('Pimote');
    expect(resolveAppName({ appName: '   ' })).toBe('Pimote');
  });
});

describe('setMetaContent', () => {
  it('replaces the content of an existing meta tag', () => {
    const html = '<head><meta name="application-name" content="Pimote" /></head>';
    expect(setMetaContent(html, 'application-name', 'Desk Pi')).toBe('<head><meta name="application-name" content="Desk Pi" /></head>');
  });

  it('leaves the document untouched when the meta tag is absent', () => {
    const html = '<head><meta name="other" content="Pimote" /></head>';
    expect(setMetaContent(html, 'application-name', 'Desk Pi')).toBe(html);
  });

  it('escapes characters that would break the attribute', () => {
    const html = '<meta name="application-name" content="Pimote" />';
    expect(setMetaContent(html, 'application-name', 'Pi & "Co" <beta>')).toBe('<meta name="application-name" content="Pi &amp; &quot;Co&quot; &lt;beta&gt;" />');
  });
});

describe('applyAppNameToHtml', () => {
  const shell =
    '<head><meta name="application-name" content="Pimote" />' +
    '<meta name="apple-mobile-web-app-title" content="Pimote" />' +
    '<meta name="theme-color" content="#0a0a0f" /></head>';

  it('rewrites every branded meta tag', () => {
    const out = applyAppNameToHtml(shell, 'Desk Pi');
    expect(out).toContain('<meta name="application-name" content="Desk Pi" />');
    expect(out).toContain('<meta name="apple-mobile-web-app-title" content="Desk Pi" />');
  });

  it('leaves unrelated meta tags alone', () => {
    expect(applyAppNameToHtml(shell, 'Desk Pi')).toContain('<meta name="theme-color" content="#0a0a0f" />');
  });
});

describe('applyAppNameToManifest', () => {
  it('rewrites name and short_name and preserves everything else', () => {
    const raw = JSON.stringify({ name: 'Pimote', short_name: 'Pimote', start_url: '/', icons: [1] });
    const out = JSON.parse(applyAppNameToManifest(raw, 'Desk Pi'));
    expect(out).toEqual({ name: 'Desk Pi', short_name: 'Desk Pi', start_url: '/', icons: [1] });
  });

  it('does not interpret dollar sequences in the name as replacement patterns', () => {
    const raw = JSON.stringify({ name: 'Pimote', short_name: 'Pimote' });
    expect(JSON.parse(applyAppNameToManifest(raw, '$& Co')).name).toBe('$& Co');
  });

  it('returns invalid input untouched', () => {
    expect(applyAppNameToManifest('not json', 'Desk Pi')).toBe('not json');
    expect(applyAppNameToManifest('[1,2]', 'Desk Pi')).toBe('[1,2]');
  });
});
