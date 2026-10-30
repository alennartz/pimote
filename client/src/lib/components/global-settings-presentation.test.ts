import { describe, expect, it } from 'vitest';
import { globalSettingsPresentation, type GlobalSettingsPresentationInput } from './global-settings-presentation.js';

const input: GlobalSettingsPresentationInput = {
  viewport: 'desktop',
  path: '/agent/AGENTS.md',
  dirty: false,
  snippets: ['note', 'tip'],
};

describe('Global settings presentation', () => {
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
