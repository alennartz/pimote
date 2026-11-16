// Content-driven editor-language resolution. Split from `editor-language.ts`
// so the pure path/title mappers stay loadable without highlight.js — this
// module is reached only from the lazy editor surfaces that need detection.

import { detectHighlightedLanguage } from './syntax-highlighter.js';
import { getLanguageLabel, mapHighlightLanguage, inferLanguageFromTitle, type ResolvedEditorLanguage } from './editor-language.js';

export type { EditorLanguage, ResolvedEditorLanguage } from './editor-language.js';

export function inferLanguageFromContent(prefill: string): ResolvedEditorLanguage | null {
  const id = mapHighlightLanguage(detectHighlightedLanguage(prefill));
  if (!id) return null;

  return {
    id,
    label: getLanguageLabel(id),
    source: 'prefill',
  };
}

export function resolveEditorLanguage(title?: string, prefill?: string): ResolvedEditorLanguage | null {
  if (title) {
    const fromTitle = inferLanguageFromTitle(title);
    if (fromTitle) return fromTitle;
  }

  if (prefill) {
    return inferLanguageFromContent(prefill);
  }

  return null;
}
