import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { diff as diffMode } from '@codemirror/legacy-modes/mode/diff';
import type { EditorLanguage } from './editor-language.js';

export function getCodeMirrorLanguageExtension(language: EditorLanguage | null): Extension | undefined {
  switch (language) {
    case 'typescript':
      return javascript({ typescript: true });
    case 'javascript':
      return javascript();
    case 'json':
      return json();
    case 'python':
      return python();
    case 'shell':
      return StreamLanguage.define(shellMode);
    case 'html':
      return html();
    case 'xml':
      return xml();
    case 'css':
      return css();
    case 'markdown':
      return markdown();
    case 'yaml':
      return yaml();
    case 'sql':
      return sql();
    case 'diff':
      return StreamLanguage.define(diffMode);
    default:
      return undefined;
  }
}
