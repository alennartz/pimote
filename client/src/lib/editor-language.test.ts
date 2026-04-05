import { describe, expect, it } from 'vitest';
import { extractFilenameFromTitle, inferLanguageFromContent, inferLanguageFromTitle, resolveEditorLanguage } from './editor-language.js';

describe('extractFilenameFromTitle', () => {
  it('extracts a plain filename', () => {
    expect(extractFilenameFromTitle('server/src/ws-handler.ts')).toBe('server/src/ws-handler.ts');
  });

  it('extracts a file-like token from a longer title', () => {
    expect(extractFilenameFromTitle('Edit client/src/routes/+layout.svelte before saving')).toBe('client/src/routes/+layout.svelte');
  });

  it('trims surrounding punctuation from a file-like token', () => {
    expect(extractFilenameFromTitle('Editing "config.yaml": review values')).toBe('config.yaml');
  });

  it('returns null when the title has no file-like token', () => {
    expect(extractFilenameFromTitle('Edit some text')).toBeNull();
  });
});

describe('inferLanguageFromTitle', () => {
  it('maps TypeScript-like paths from the title', () => {
    expect(inferLanguageFromTitle('Edit server/src/ws-handler.ts')).toMatchObject({
      id: 'typescript',
      source: 'title',
      matchedPath: 'server/src/ws-handler.ts',
    });
  });

  it('maps yaml filenames from the title', () => {
    expect(inferLanguageFromTitle('Review config.yaml')).toMatchObject({
      id: 'yaml',
      source: 'title',
      matchedPath: 'config.yaml',
    });
  });

  it('maps svelte files to the html editor mode', () => {
    expect(inferLanguageFromTitle('Edit client/src/routes/+page.svelte')).toMatchObject({
      id: 'html',
      source: 'title',
    });
  });
});

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
