/**
 * Custom streaming-markdown renderer with highlight.js syntax highlighting.
 *
 * Wraps smd's default_renderer to intercept end_token: when a code block
 * closes (a <code> element inside a <pre>), runs hljs.highlightElement()
 * on it. The language class is already set by smd's set_attr(LANG) call.
 */
import * as smd from 'streaming-markdown';
import { hljs } from './syntax-highlighter.js';

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
    end_token(data: smd.Default_Renderer_Data) {
      const node = data.nodes[data.index];
      // CODE_FENCE and CODE_BLOCK both create <pre><code> — highlight when the <code> closes
      if (node?.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
        const codeEl = node as HTMLElement;
        const preEl = codeEl.parentElement as HTMLElement;
        try {
          hljs.highlightElement(codeEl);
        } catch {
          // Leave code unhighlighted — don't let hljs errors corrupt smd's node stack
        }
        attachCopyButton(preEl, codeEl);
      }
      smd.default_end_token(data);
    },
  };
}
