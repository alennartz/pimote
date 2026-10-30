import { inferLanguageFromPath } from '$lib/editor-language.js';

export interface GlobalSettingsPresentationInput {
  surface: 'home' | 'conversation';
  viewport: 'desktop' | 'mobile';
  path: string;
  dirty: boolean;
  snippets: readonly string[];
}

export interface GlobalSettingsPresentation {
  gear: { placement: 'bottom-left' | 'top-left'; size: 'large' | 'small' } | null;
  language: 'markdown' | 'json' | 'text';
  tagSnippets: readonly string[];
  actions: { placement: 'header' | 'footer'; closeLabel: 'Close' | 'Cancel'; saveEnabled: boolean };
}

export function globalSettingsPresentation(input: GlobalSettingsPresentationInput): GlobalSettingsPresentation {
  const inferred = inferLanguageFromPath(input.path);
  const language = inferred === 'markdown' || inferred === 'json' ? inferred : 'text';
  const mobile = input.viewport === 'mobile';
  return {
    gear: input.surface === 'home' ? { placement: mobile ? 'top-left' : 'bottom-left', size: mobile ? 'small' : 'large' } : null,
    language,
    tagSnippets: language === 'markdown' ? [...input.snippets] : [],
    actions: { placement: mobile ? 'header' : 'footer', closeLabel: mobile ? 'Close' : 'Cancel', saveEnabled: input.dirty },
  };
}
