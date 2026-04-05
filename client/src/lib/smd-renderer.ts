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
        try {
          hljs.highlightElement(node as HTMLElement);
        } catch {
          // Leave code unhighlighted — don't let hljs errors corrupt smd's node stack
        }
      }
      smd.default_end_token(data);
    },
  };
}
