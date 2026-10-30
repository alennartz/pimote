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

export function globalSettingsPresentation(_input: GlobalSettingsPresentationInput): GlobalSettingsPresentation {
  throw new Error('not implemented');
}
