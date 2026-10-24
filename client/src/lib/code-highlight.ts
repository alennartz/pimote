import { hljs } from './syntax-highlighter.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  if (language && hljs.getLanguage(language)) {
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

  return {
    schedule(el: HTMLElement, text: string, language: string | null) {
      pending = { el, text, language };
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
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
