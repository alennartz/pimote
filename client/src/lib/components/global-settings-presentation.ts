import { inferLanguageFromPath } from '$lib/editor-language.js';

export interface GlobalSettingsPresentationInput {
  viewport: 'desktop' | 'mobile';
  path: string;
  dirty: boolean;
  snippets: readonly string[];
}

export interface GlobalSettingsPresentation {
  language: 'markdown' | 'json' | 'text';
  tagSnippets: readonly string[];
  actions: { placement: 'header' | 'footer'; closeLabel: 'Close' | 'Cancel'; saveEnabled: boolean };
}

export function globalSettingsPresentation(input: GlobalSettingsPresentationInput): GlobalSettingsPresentation {
  const inferred = inferLanguageFromPath(input.path);
  const language = inferred === 'markdown' || inferred === 'json' ? inferred : 'text';
  const mobile = input.viewport === 'mobile';
  return {
    language,
    tagSnippets: language === 'markdown' ? [...input.snippets] : [],
    actions: { placement: mobile ? 'header' : 'footer', closeLabel: mobile ? 'Close' : 'Cancel', saveEnabled: input.dirty },
  };
}
