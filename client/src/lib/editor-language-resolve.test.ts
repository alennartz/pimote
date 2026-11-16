import { describe, expect, it } from 'vitest';
import { inferLanguageFromContent, resolveEditorLanguage } from './editor-language-resolve.js';

describe('inferLanguageFromContent', () => {
  it('auto-detects python from prefill content', () => {
    expect(inferLanguageFromContent('def greet(name):\n    print(f"Hello, {name}")\n')).toMatchObject({ id: 'python', source: 'prefill' });
  });
});

describe('resolveEditorLanguage', () => {
  it('prefers title inference over content auto-detect', () => {
    expect(resolveEditorLanguage('migration.sql', 'const answer: number = 42;')).toMatchObject({ id: 'sql', source: 'title' });
  });

  it('falls back to content auto-detect when title is not file-like', () => {
    expect(resolveEditorLanguage('Edit snippet', 'const answer: number = 42;\nconsole.log(answer);\n')).toMatchObject({ id: 'typescript', source: 'prefill' });
  });

  it('returns null when neither title nor content provide a language signal', () => {
    expect(resolveEditorLanguage('Edit snippet', '')).toBeNull();
  });
});
