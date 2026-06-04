/**
 * Custom streaming-markdown renderer with highlight.js syntax highlighting.
 *
 * Wraps smd's default_renderer to highlight fenced code _while it streams_:
 * each `add_text` into a <code> element (re)schedules a throttled re-highlight
 * over the full buffer, and `end_token` forces a final synchronous flush. The
 * language class is set by smd's set_attr(LANG) call; we read the hljs language
 * id from that `language-<id>` class rather than threading separate state.
 *
 * Safe because smd holds references to elements only (never text nodes) and
 * inside a fence only ever appends text: replacing the <code> element's
 * children (what highlighting does) never corrupts smd's node stack — the next
 * append adds a fresh text node onto the same stable <code>, and the next
 * highlight pass re-reads the full `textContent` and rebuilds.
 */
import * as smd from 'streaming-markdown';
import { createIncrementalHighlighter } from './code-highlight.js';

/**
 * Read the hljs language id from a code element's class list. smd applies the
 * fence info-string as a bare class (e.g. `typescript`); we also support the
 * `language-<id>` convention. The `hljs` class we add ourselves is ignored.
 */
function languageFromCodeEl(codeEl: HTMLElement): string | null {
  for (const cls of codeEl.classList) {
    if (cls === 'hljs') continue;
    return cls.startsWith('language-') ? cls.slice('language-'.length) : cls;
  }
  return null;
}

/**
 * Create an smd renderer targeting the given container element,
 * with highlight.js syntax highlighting applied when code blocks close.
 */
const SAFE_URL_PATTERN = /^(?:https?|mailto):/i;

/**
 * Create an smd renderer targeting the given container element,
 * with highlight.js syntax highlighting applied when code blocks close
 * and URL sanitization for links and images.
 */
/**
 * Wrap a <pre> in a non-scrolling positioned container and attach a copy
 * button to that wrapper. The button is anchored to the wrapper (not <pre>),
 * so it stays put when the user scrolls the code horizontally. Idempotent:
 * skips re-wrapping / re-attaching if already done.
 */
function attachCopyButton(preEl: HTMLElement, codeEl: HTMLElement): void {
  let wrapper: HTMLElement;
  const parent = preEl.parentElement;
  if (parent?.classList.contains('code-block-wrapper')) {
    wrapper = parent;
  } else if (parent) {
    wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    parent.insertBefore(wrapper, preEl);
    wrapper.appendChild(preEl);
  } else {
    return; // detached <pre> — nothing to anchor against
  }
  if (wrapper.querySelector(':scope > .code-copy-btn')) return;
  preEl.classList.add('code-block-with-copy');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy-btn';
  btn.setAttribute('aria-label', 'Copy code');
  btn.title = 'Copy code';
  btn.textContent = 'Copy';
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(codeEl.textContent ?? '');
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1200);
    } catch {
      // Clipboard unavailable — leave button as-is.
    }
  });
  wrapper.appendChild(btn);
}

export function createRenderer(container: HTMLElement): smd.Default_Renderer {
  const base = smd.default_renderer(container);
  const highlighter = createIncrementalHighlighter();

  return {
    ...base,
    set_attr(data: smd.Default_Renderer_Data, type: smd.Attr, value: string) {
      // Sanitize href/src to prevent javascript: and other dangerous URL schemes
      if (type === smd.Attr.Href || type === smd.Attr.Src) {
        if (!SAFE_URL_PATTERN.test(value.trim())) {
          return; // silently drop unsafe URLs
        }
      }
      smd.default_set_attr(data, type, value);
    },
    add_text(data: smd.Default_Renderer_Data, text: string) {
      // Append the fresh text node first (smd holds element refs only).
      smd.default_add_text(data, text);
      const node = data.nodes[data.index];
      // Inside a fenced/indented code block — re-highlight the full buffer.
      if (node?.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
        const codeEl = node as HTMLElement;
        codeEl.classList.add('hljs');
        highlighter.schedule(codeEl, codeEl.textContent ?? '', languageFromCodeEl(codeEl));
      }
    },
    end_token(data: smd.Default_Renderer_Data) {
      const node = data.nodes[data.index];
      // CODE_FENCE and CODE_BLOCK both create <pre><code> — force the final
      // highlight pass when the <code> closes.
      if (node?.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
        const codeEl = node as HTMLElement;
        const preEl = codeEl.parentElement as HTMLElement;
        codeEl.classList.add('hljs');
        try {
          highlighter.flush();
        } catch {
          // Leave code unhighlighted — don't let hljs errors corrupt smd's node stack
        }
        attachCopyButton(preEl, codeEl);
      }
      smd.default_end_token(data);
    },
  };
}
