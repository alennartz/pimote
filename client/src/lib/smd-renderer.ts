/**
 * Custom streaming-markdown renderer with highlight.js syntax highlighting.
 *
 * Wraps smd's default_renderer to intercept end_token: when a code block
 * closes (a <code> element inside a <pre>), runs hljs.highlightElement()
 * on it. The language class is already set by smd's set_attr(LANG) call.
 */
import * as smd from 'streaming-markdown';
import hljs from 'highlight.js/lib/core';

import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import shell from 'highlight.js/lib/languages/shell';
import diff from 'highlight.js/lib/languages/diff';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('diff', diff);

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
