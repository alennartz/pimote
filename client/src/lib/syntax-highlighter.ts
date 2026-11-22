import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

// `lib/common` registers the 36 most-used grammars together with all of
// their aliases (ts, jsx, rb, rs, patch, gql, ...). Dockerfile is the
// notable gap for agent transcripts, so register it too.
hljs.registerLanguage('dockerfile', dockerfile);

export { hljs };

export function detectHighlightedLanguage(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  const result = hljs.highlightAuto(trimmed.slice(0, 20_000));
  return result.language ?? null;
}
