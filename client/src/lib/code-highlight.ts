function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Syntax-highlighter module state. The module loads behind a dynamic import
 *  on the first language-bearing code fence, and every live highlighter
 *  re-renders its last element once it lands. */
type SyntaxHighlighterModule = typeof import('./syntax-highlighter.js');

let hljsModule: SyntaxHighlighterModule | null = null;
let hljsLoading: Promise<SyntaxHighlighterModule> | null = null;
const liveHighlighters = new Set<{ rerenderLast(): void }>();

/** Resolve the syntax-highlighter module. Until it lands,
 *  `highlightToHtml` emits HTML-escaped plain text; every scheduled element
 *  upgrades automatically when the module arrives. */
export function ensureHljs(): Promise<SyntaxHighlighterModule> {
  if (hljsModule) return Promise.resolve(hljsModule);
  hljsLoading ??= import('./syntax-highlighter.js')
    .then((module) => {
      hljsModule = module;
      for (const highlighter of liveHighlighters) highlighter.rerenderLast();
      return module;
    })
    .catch((error: unknown) => {
      hljsLoading = null;
      throw error;
    });
  return hljsLoading;
}

/** Extensions that are not registered hljs language aliases. Maps them to a
 *  registered grammar so path-based coverage stays complete without keeping
 *  a per-language extension map elsewhere. */
const EXTENSION_LANGUAGE_FALLBACK: Record<string, string> = {
  pyi: 'python',
  ksh: 'bash',
  htm: 'xml',
  mdx: 'markdown',
  svelte: 'xml',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
};

/**
 * Resolve a file path to an hljs language id.
 *
 * The extension is matched against registered grammar aliases (ts, py, rb,
 * go, ...); a small fallback map covers suffixes that are not aliases, and
 * extension-less names match their basename (Dockerfile, Makefile). Returns
 * the canonical registered id (typescript, not ts) or null for unknown
 * extensions, dotfiles, and empty paths; never throws. Resolves once the
 * lazy highlighter module has loaded.
 */
export async function resolveHighlightLanguageFromPath(path: string): Promise<string | null> {
  const last = path.split(/[/\\]/).pop() ?? '';
  if (!last) return null;
  const dot = last.lastIndexOf('.');
  const key = dot > 0 ? last.slice(dot + 1).toLowerCase() : last.toLowerCase();
  if (!key) return null;
  try {
    const { hljs } = await ensureHljs();
    const fallback = EXTENSION_LANGUAGE_FALLBACK[key];
    if (fallback) return fallback;
    const descriptor = hljs.getLanguage(key);
    if (!descriptor) return null;
    // Normalize aliases (ts, md, rb, ...) to the registered grammar id so
    // consumers can compare against canonical ids.
    return hljs.listLanguages().find((id) => hljs.getLanguage(id) === descriptor) ?? key;
  } catch {
    return null;
  }
}

/**
 * Highlight a complete code string to hljs HTML markup.
 *
 * - When `language` is a registered hljs language id, returns the highlighted
 *   HTML (with `hljs-*` span classes).
 * - When `language` is null or not a registered language, returns the
 *   HTML-escaped plain text with no spans.
 * - Never throws: any hljs error falls back to HTML-escaped plain text.
 */
export function highlightToHtml(text: string, language: string | null): string {
  const hljs = hljsModule?.hljs;
  if (language && hljs?.getLanguage(language)) {
    try {
      return hljs.highlight(text, { language }).value;
    } catch {
      return escapeHtml(text);
    }
  }
  return escapeHtml(text);
}

export interface IncrementalHighlighter {
  /**
   * Request a re-highlight of `el` from the latest `text`. At most one
   * highlight runs per `intervalMs` (trailing edge); repeated calls within a
   * window collapse to a single pass using the most recent `(el, text,
   * language)`.
   */
  schedule(el: HTMLElement, text: string, language: string | null): void;
  /**
   * Force an immediate highlight of the latest pending request and cancel any
   * pending timer. After `flush()`, the element's `innerHTML` equals
   * `highlightToHtml(text, language)` for the most recent scheduled values.
   */
  flush(): void;
  /** Cancel pending timers and release state. Idempotent. */
  dispose(): void;
}

/**
 * Create a time-budgeted throttled highlighter.
 *
 * Behavioral contract:
 * - Calling `schedule` repeatedly within `intervalMs` results in a single
 *   highlight pass at the end of the window, using the most recent `text`.
 * - `flush` always renders the latest scheduled `(el, text, language)`
 *   synchronously, leaving `el.innerHTML === highlightToHtml(text, language)`.
 * - After a settled schedule or a `flush` with no further `schedule` calls,
 *   the element content is final and correct regardless of prior timing.
 * - Default `intervalMs` is ~100.
 */
export function createIncrementalHighlighter(opts?: { intervalMs?: number }): IncrementalHighlighter {
  const intervalMs = opts?.intervalMs ?? 100;

  let pending: { el: HTMLElement; text: string; language: string | null } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (!pending) return;
    const { el, text, language } = pending;
    el.innerHTML = highlightToHtml(text, language);
  };

  const highlighter = {
    schedule(el: HTMLElement, text: string, language: string | null) {
      pending = { el, text, language };
      if (language && !hljsModule) void ensureHljs().catch(() => {});
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          run();
        }, intervalMs);
      }
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    },
    dispose() {
      liveHighlighters.delete(highlighter);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
    /** Upgrade pass: the highlighter module landed after this element was
     *  rendered; re-render the latest values now. */
    rerenderLast() {
      run();
    },
  };
  liveHighlighters.add(highlighter);
  return highlighter;
}
