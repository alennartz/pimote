import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { ResolvedTheme } from '@pimote/shared';

const syntaxTagRoles: Array<[unknown, keyof ResolvedTheme['editor']['syntax']]> = [
  [tags.comment, 'comment'],
  [tags.docComment, 'doc-comment'],
  [tags.name, 'name'],
  [tags.variableName, 'variable'],
  [tags.definition(tags.variableName), 'variable'],
  [tags.local(tags.variableName), 'variable'],
  [tags.typeName, 'type'],
  [tags.tagName, 'tag'],
  [tags.propertyName, 'property'],
  [tags.attributeName, 'attribute'],
  [tags.className, 'class'],
  [tags.labelName, 'label'],
  [tags.namespace, 'namespace'],
  [tags.macroName, 'macro'],
  [tags.constant(tags.variableName), 'constant'],
  [tags.function(tags.variableName), 'function'],
  [tags.standard(tags.variableName), 'built-in'],
  [tags.keyword, 'keyword'],
  [tags.controlKeyword, 'control-keyword'],
  [tags.definitionKeyword, 'definition-keyword'],
  [tags.modifier, 'modifier'],
  [tags.operatorKeyword, 'operator-keyword'],
  [tags.operator, 'operator'],
  [tags.punctuation, 'punctuation'],
  [tags.separator, 'separator'],
  [tags.brace, 'bracket'],
  [tags.string, 'string'],
  [tags.docString, 'doc-string'],
  [tags.character, 'character'],
  [tags.attributeValue, 'attribute-value'],
  [tags.number, 'number'],
  [tags.bool, 'boolean'],
  [tags.null, 'null'],
  [tags.regexp, 'regexp'],
  [tags.escape, 'escape'],
  [tags.color, 'color'],
  [tags.url, 'url'],
  [tags.content, 'content'],
  [tags.heading, 'heading'],
  [tags.contentSeparator, 'content-separator'],
  [tags.list, 'list'],
  [tags.quote, 'quote'],
  [tags.emphasis, 'emphasis'],
  [tags.strong, 'strong'],
  [tags.link, 'link'],
  [tags.monospace, 'monospace'],
  [tags.strikethrough, 'strikethrough'],
  [tags.inserted, 'inserted'],
  [tags.deleted, 'deleted'],
  [tags.changed, 'changed'],
  [tags.invalid, 'invalid'],
  [tags.meta, 'meta'],
  [tags.documentMeta, 'document-meta'],
  [tags.annotation, 'annotation'],
  [tags.processingInstruction, 'processing-instruction'],
];

/** Create a CodeMirror theme for one paired Pimote editor palette. */
export function createCodeMirrorTheme(theme: ResolvedTheme): Extension {
  const surface = theme.editor.surface;
  const syntax = theme.editor.syntax;
  const highlight = HighlightStyle.define(syntaxTagRoles.map(([tag, role]) => ({ tag: tag as Parameters<typeof HighlightStyle.define>[0][number]['tag'], color: syntax[role] })));
  return [
    EditorView.theme(
      {
        '&': { color: surface.foreground, backgroundColor: surface.background },
        '.cm-content': { caretColor: surface.cursor },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: surface.cursor },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground, & .cm-selectionBackground': {
          backgroundColor: surface.selection,
        },
        '::selection': { backgroundColor: surface.selection, color: surface['selection-foreground'] },
        '.cm-activeLine': { backgroundColor: surface['active-line'] },
        '.cm-gutters': { backgroundColor: surface['gutter-background'], color: surface['gutter-foreground'], border: 'none' },
        '.cm-lineNumbers .cm-gutterElement': { color: surface['line-number'] },
        '.cm-activeLineGutter': { backgroundColor: surface['active-line'], color: surface['active-line-number'] },
        '.cm-matchingBracket': { backgroundColor: surface['matching-bracket'] },
        '.cm-searchMatch': {
          backgroundColor: 'transparent',
          textDecoration: `underline 2px ${surface['search-match']}`,
          textUnderlineOffset: '2px',
        },
        '.cm-searchMatch-selected': { backgroundColor: surface.selection, color: surface['selection-foreground'], textDecoration: 'none' },
      },
      { dark: theme.colorScheme === 'dark' },
    ),
    syntaxHighlighting(highlight),
  ];
}
