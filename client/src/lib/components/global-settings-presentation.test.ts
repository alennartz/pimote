import { describe, expect, it } from 'vitest';
import { globalSettingsPresentation, type GlobalSettingsPresentationInput } from './global-settings-presentation.js';

const input: GlobalSettingsPresentationInput = {
  surface: 'home',
  viewport: 'desktop',
  path: '/agent/AGENTS.md',
  dirty: false,
  snippets: ['note', 'tip'],
};

describe('Global settings presentation', () => {
  it('places the large home gear at desktop bottom-left', () => {
    expect(globalSettingsPresentation(input).gear).toEqual({ placement: 'bottom-left', size: 'large' });
  });

  it('places the small home gear at mobile top-left', () => {
    expect(globalSettingsPresentation({ ...input, viewport: 'mobile' }).gear).toEqual({ placement: 'top-left', size: 'small' });
  });

  it.each(['desktop', 'mobile'] as const)('omits the gear from the %s conversation surface', (viewport) => {
    expect(globalSettingsPresentation({ ...input, surface: 'conversation', viewport }).gear).toBeNull();
  });

  it.each(['/agent/AGENTS.md', '/custom/instructions.markdown'])('offers capability tag snippets for Markdown path %s', (path) => {
    const view = globalSettingsPresentation({ ...input, path });
    expect(view.language).toBe('markdown');
    expect(view.tagSnippets).toEqual(['note', 'tip']);
  });

  it('uses the resolved JSON path for language and omits Markdown controls', () => {
    const view = globalSettingsPresentation({ ...input, path: '/xdg/pimote/config.json' });
    expect(view.language).toBe('json');
    expect(view.tagSnippets).toEqual([]);
  });

  it('omits Markdown controls for plain text files', () => {
    const view = globalSettingsPresentation({ ...input, path: '/custom/preferences.txt' });
    expect(view.language).toBe('text');
    expect(view.tagSnippets).toEqual([]);
  });

  it('uses Cancel and Save in the desktop footer', () => {
    const actions = globalSettingsPresentation({ ...input, dirty: true }).actions;
    expect(actions.placement).toBe('footer');
    expect(actions.closeLabel).toBe('Cancel');
    expect(actions.saveEnabled).toBe(true);
  });

  it('uses Close and Save in the mobile header', () => {
    const actions = globalSettingsPresentation({ ...input, viewport: 'mobile', dirty: true }).actions;
    expect(actions.placement).toBe('header');
    expect(actions.closeLabel).toBe('Close');
    expect(actions.saveEnabled).toBe(true);
  });

  it.each(['desktop', 'mobile'] as const)('disables Save for a clean tab on %s', (viewport) => {
    expect(globalSettingsPresentation({ ...input, viewport }).actions.saveEnabled).toBe(false);
  });
});
