/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIncrementalHighlighter, ensureHljs, highlightToHtml, resolveHighlightLanguageFromPath } from './code-highlight.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('highlightToHtml', () => {
  it('emits hljs span markup for a registered language', async () => {
    await ensureHljs();
    const html = highlightToHtml('const x = 1;', 'typescript');
    expect(html).toContain('<span');
    expect(html).toContain('hljs-');
  });

  it('preserves the original source text content under highlighting', () => {
    const html = highlightToHtml('const answer = 42;', 'typescript');
    // Strip tags to recover the rendered text.
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toContain('answer');
    expect(text).toContain('42');
  });

  it('returns HTML-escaped plain text with no spans when language is null', () => {
    const html = highlightToHtml('<a> & "b"', null);
    expect(html).not.toContain('<span');
    expect(html).toContain('&lt;a&gt;');
    expect(html).toContain('&amp;');
  });

  it('returns HTML-escaped plain text with no spans for an unregistered language', () => {
    const html = highlightToHtml('<x>', 'definitely-not-a-real-language');
    expect(html).not.toContain('<span');
    expect(html).toContain('&lt;x&gt;');
  });

  it('never throws on an unknown language', () => {
    expect(() => highlightToHtml('whatever { ] (', 'nope-not-real')).not.toThrow();
  });

  it('returns an empty string for empty input with a null language', () => {
    expect(highlightToHtml('', null)).toBe('');
  });
});

describe('resolveHighlightLanguageFromPath', () => {
  it('resolves extensions that are registered aliases', async () => {
    await ensureHljs();
    expect(await resolveHighlightLanguageFromPath('src/app.ts')).toBe('typescript');
    expect(await resolveHighlightLanguageFromPath('main.go')).toBe('go');
    expect(await resolveHighlightLanguageFromPath('README.MD')).toBe('markdown');
  });

  it('maps suffixes that are not aliases to a registered grammar', async () => {
    expect(await resolveHighlightLanguageFromPath('components/App.svelte')).toBe('xml');
    expect(await resolveHighlightLanguageFromPath('a/b/c.pyi')).toBe('python');
    expect(await resolveHighlightLanguageFromPath('app.cfg')).toBe('ini');
  });

  it('matches extension-less basenames like Dockerfile and Makefile', async () => {
    expect(await resolveHighlightLanguageFromPath('deploy/Dockerfile')).toBe('dockerfile');
    expect(await resolveHighlightLanguageFromPath('Makefile')).toBe('makefile');
  });

  it('splits windows-style paths', async () => {
    expect(await resolveHighlightLanguageFromPath('C:\\web\\index.htm')).toBe('xml');
  });

  it('returns null for unknown extensions, dotfiles, and empty paths', async () => {
    expect(await resolveHighlightLanguageFromPath('notes.zzz')).toBeNull();
    expect(await resolveHighlightLanguageFromPath('.gitignore')).toBeNull();
    expect(await resolveHighlightLanguageFromPath('dir/')).toBeNull();
    expect(await resolveHighlightLanguageFromPath('')).toBeNull();
  });
});

describe('createIncrementalHighlighter', () => {
  it('flush renders the latest scheduled values synchronously', () => {
    const el = document.createElement('code');
    const h = createIncrementalHighlighter();
    h.schedule(el, 'const x = 1;', 'typescript');
    h.flush();
    expect(el.innerHTML).toBe(highlightToHtml('const x = 1;', 'typescript'));
    h.dispose();
  });

  it('flush uses the most recent scheduled text when called repeatedly', () => {
    const el = document.createElement('code');
    const h = createIncrementalHighlighter();
    h.schedule(el, 'let a = 1;', 'typescript');
    h.schedule(el, 'let a = 1; let b = 2;', 'typescript');
    h.flush();
    expect(el.innerHTML).toBe(highlightToHtml('let a = 1; let b = 2;', 'typescript'));
    h.dispose();
  });

  it('renders escaped plain text after flush when language is null', () => {
    const el = document.createElement('code');
    const h = createIncrementalHighlighter();
    h.schedule(el, '<tag> & more', null);
    h.flush();
    expect(el.innerHTML).toBe(highlightToHtml('<tag> & more', null));
    expect(el.innerHTML).not.toContain('<span');
    h.dispose();
  });

  it('collapses repeated schedules within the window into a single trailing pass using the latest text', () => {
    vi.useFakeTimers();
    const el = document.createElement('code');
    const h = createIncrementalHighlighter({ intervalMs: 100 });
    h.schedule(el, 'a', null);
    h.schedule(el, 'ab', null);
    h.schedule(el, 'abc', null);
    // Trailing edge: nothing rendered until the window elapses.
    expect(el.innerHTML).toBe('');
    vi.advanceTimersByTime(100);
    expect(el.innerHTML).toBe(highlightToHtml('abc', null));
    h.dispose();
  });

  it('renders a settled schedule after the interval without an explicit flush', () => {
    vi.useFakeTimers();
    const el = document.createElement('code');
    const h = createIncrementalHighlighter({ intervalMs: 100 });
    h.schedule(el, 'value = 7', 'python');
    vi.advanceTimersByTime(100);
    expect(el.innerHTML).toBe(highlightToHtml('value = 7', 'python'));
    h.dispose();
  });

  it('dispose cancels a pending highlight', () => {
    vi.useFakeTimers();
    const el = document.createElement('code');
    const h = createIncrementalHighlighter({ intervalMs: 100 });
    h.schedule(el, 'const x = 1;', 'typescript');
    h.dispose();
    vi.advanceTimersByTime(1000);
    expect(el.innerHTML).toBe('');
  });

  it('dispose is idempotent', () => {
    const h = createIncrementalHighlighter();
    expect(() => {
      h.dispose();
      h.dispose();
    }).not.toThrow();
  });

  it('flush with nothing scheduled does not throw', () => {
    const h = createIncrementalHighlighter();
    expect(() => h.flush()).not.toThrow();
    h.dispose();
  });
});
