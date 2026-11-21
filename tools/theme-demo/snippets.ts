import { HighlightStyle } from '@codemirror/language';
import { typescriptLanguage } from '@codemirror/lang-javascript';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { highlightTree } from '@lezer/highlight';
import type { Tree } from '@lezer/common';
import type { SyntaxScope } from '@pimote/shared';
import { syntaxTagRoles } from '../../client/src/lib/codemirror-theme.js';

/** A TypeScript module that exercises the scopes a reader meets most often. */
export const typescriptSnippet = `import { readFile } from 'node:fs/promises';

/** A session the registry tracks while it runs. */
export interface SessionSnapshot {
  id: string;
  title: string;
  running: boolean;
  tokens: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SessionRegistry {
  #sessions = new Map<string, SessionSnapshot>();

  register(snapshot: SessionSnapshot): void {
    if (!SLUG.test(snapshot.id)) {
      throw new Error(\`invalid session id: \${snapshot.id}\`);
    }
    this.#sessions.set(snapshot.id, snapshot);
  }

  async load(path: string): Promise<SessionSnapshot[]> {
    const raw = await readFile(path, 'utf8'); // 0x00 bytes are dropped
    return JSON.parse(raw) as SessionSnapshot[];
  }

  get running(): number {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.running) count += 1;
    }
    return count;
  }
}
`;

/** A Markdown document that exercises every prose scope the editor paints. */
export const markdownSnippet = `# Release checklist

The queue drains in **two** passes, and *never* out of order.

## Steps

1. Build the server and the client.
2. Run the audit:

   \`\`\`sh
   npm run audit:themes
   \`\`\`

3. Tag the commit and push.

- [x] Themes audited
- [ ] Snapshot published

> A theme that fails contrast stops the release.

Read the [release guide](https://example.com/release) or the ~~old notes~~.

| Theme | Errors | Warnings |
| --- | --- | --- |
| Nord | 1 | 4 |
| Latte | 0 | 3 |

Inline code such as \`--pimote-editor-syntax-markup-list\` inherits the raw scope.

---

Report problems to \`#themes\`.
`;

const tokenClass = (scope: SyntaxScope): string => `tok-${scope.replaceAll('.', '-')}`;

const highlight = HighlightStyle.define(
  syntaxTagRoles.map(([tag, scope]) => ({
    tag: tag as Parameters<typeof HighlightStyle.define>[0][number]['tag'],
    class: tokenClass(scope),
  })),
);

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Render a snippet the way the editor paints it: one winning scope per span, plus emphasis styles. */
function renderTree(code: string, tree: Tree): string {
  let html = '';
  let position = 0;
  highlightTree(tree, highlight, (from, to, classes) => {
    html += escapeHtml(code.slice(position, from));
    const matched = classes.split(' ').filter(Boolean);
    const winner = matched.at(-1);
    const emphasis = [matched.includes(tokenClass('markup.bold')) ? 'is-bold' : '', matched.includes(tokenClass('markup.italic')) ? 'is-italic' : ''].filter(Boolean);
    const className = [winner, ...emphasis].filter(Boolean).join(' ');
    html += `<span class="${className}">${escapeHtml(code.slice(from, to))}</span>`;
    position = to;
  });
  html += escapeHtml(code.slice(position));
  return html;
}

/** Highlighted HTML for the snippets, which take their colors from the active theme's variables. */
export function renderSnippets(): { typescript: string; markdown: string } {
  return {
    typescript: renderTree(typescriptSnippet, typescriptLanguage.parser.parse(typescriptSnippet)),
    markdown: renderTree(markdownSnippet, markdownParser.configure(GFM).parse(markdownSnippet)),
  };
}
