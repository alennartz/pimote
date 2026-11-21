import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { ResolvedTheme, SyntaxScope } from '@pimote/shared';

const syntaxTagRoles: Array<[unknown, SyntaxScope]> = [
  [tags.comment, 'comment'],
  [tags.lineComment, 'comment'],
  [tags.blockComment, 'comment'],
  [tags.docComment, 'comment.documentation'],
  [tags.name, 'entity'],
  [tags.variableName, 'variable.other'],
  [tags.definition(tags.variableName), 'variable.other'],
  [tags.local(tags.variableName), 'variable.other'],
  [tags.self, 'variable.language'],
  [tags.typeName, 'entity.name.type'],
  [tags.tagName, 'entity.name.tag'],
  [tags.propertyName, 'variable.other.property'],
  [tags.attributeName, 'entity.other.attribute-name'],
  [tags.className, 'entity.name.type'],
  [tags.labelName, 'entity.name.label'],
  [tags.namespace, 'entity.name.namespace'],
  [tags.macroName, 'entity.name.function.macro'],
  [tags.function(tags.variableName), 'entity.name.function'],
  [tags.constant(tags.variableName), 'constant'],
  [tags.standard(tags.variableName), 'support.function'],
  [tags.special(tags.variableName), 'support.variable'],
  [tags.keyword, 'keyword'],
  [tags.controlKeyword, 'keyword.control'],
  [tags.moduleKeyword, 'keyword.control'],
  [tags.definitionKeyword, 'storage.type'],
  [tags.modifier, 'storage.modifier'],
  [tags.operatorKeyword, 'keyword.operator'],
  [tags.operator, 'keyword.operator'],
  [tags.compareOperator, 'keyword.operator'],
  [tags.arithmeticOperator, 'keyword.operator'],
  [tags.logicOperator, 'keyword.operator'],
  [tags.bitwiseOperator, 'keyword.operator'],
  [tags.derefOperator, 'keyword.operator'],
  [tags.updateOperator, 'keyword.operator'],
  [tags.typeOperator, 'keyword.operator'],
  [tags.controlOperator, 'keyword.operator'],
  [tags.string, 'string.quoted'],
  [tags.special(tags.string), 'string.other'],
  [tags.docString, 'string.quoted'],
  [tags.attributeValue, 'string.quoted'],
  [tags.regexp, 'string.regexp'],
  [tags.character, 'constant'],
  [tags.number, 'constant.numeric'],
  [tags.integer, 'constant.numeric'],
  [tags.float, 'constant.numeric'],
  [tags.bool, 'constant.language'],
  [tags.null, 'constant.language'],
  [tags.escape, 'constant.character.escape'],
  [tags.color, 'constant.other'],
  [tags.url, 'markup.underline.link'],
  [tags.monospace, 'markup.raw'],
  [tags.heading, 'markup.heading'],
  [tags.heading1, 'markup.heading.1'],
  [tags.heading2, 'markup.heading.2'],
  [tags.heading3, 'markup.heading.3'],
  [tags.heading4, 'markup.heading.4'],
  [tags.heading5, 'markup.heading.5'],
  [tags.heading6, 'markup.heading.6'],
  [tags.contentSeparator, 'markup'],
  [tags.list, 'markup.list'],
  [tags.quote, 'markup.quote'],
  [tags.emphasis, 'markup.italic'],
  [tags.strong, 'markup.bold'],
  [tags.link, 'markup.underline.link'],
  [tags.strikethrough, 'markup.strikethrough'],
  [tags.inserted, 'markup.inserted'],
  [tags.deleted, 'markup.deleted'],
  [tags.changed, 'markup.changed'],
  [tags.invalid, 'invalid'],
  [tags.meta, 'meta'],
  [tags.documentMeta, 'meta'],
  [tags.annotation, 'meta'],
  [tags.processingInstruction, 'markup.punctuation'],
];

/** Markdown emphasis carries its own font style, as it does in every editor. */
function emphasisStyle(scope: SyntaxScope): { fontStyle?: string; fontWeight?: string } {
  if (scope === 'markup.italic') return { fontStyle: 'italic' };
  if (scope === 'markup.bold') return { fontWeight: 'bold' };
  return {};
}

/** Create a CodeMirror theme for one paired Pimote editor palette. */
export function createCodeMirrorTheme(theme: ResolvedTheme): Extension {
  const surface = theme.editor.surface;
  const syntax = theme.editor.syntax;
  const highlight = HighlightStyle.define(
    syntaxTagRoles.map(([tag, scope]) => ({
      tag: tag as Parameters<typeof HighlightStyle.define>[0][number]['tag'],
      color: syntax[scope],
      ...emphasisStyle(scope),
    })),
  );
  return [
    EditorView.theme(
      {
        '&': { color: surface.foreground, backgroundColor: surface.background },
        '.cm-content': { caretColor: surface.cursor },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: surface.cursor },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground, & .cm-selectionLayer .cm-selectionBackground': {
          backgroundColor: surface.selection,
        },
        '& .cm-line::selection, .cm-content ::selection': { backgroundColor: surface.selection, color: surface['selection-foreground'] },
        '&:has(.cm-selectionLayer .cm-selectionBackground) .cm-activeLine': { backgroundColor: 'transparent' },
        '.cm-activeLine': { backgroundColor: surface['active-line'] },
        '.cm-gutters': { backgroundColor: surface['gutter-background'], color: surface['gutter-foreground'], border: 'none' },
        '.cm-lineNumbers .cm-gutterElement': { color: surface['line-number'] },
        '.cm-activeLineGutter': { backgroundColor: surface['active-line'], color: surface['active-line-number'] },
        '.cm-matchingBracket': { backgroundColor: surface['matching-bracket'] },
        '.cm-searchMatch': {
          backgroundColor: surface['search-match'],
        },
        '.cm-searchMatch-selected': { backgroundColor: surface.selection, color: surface['selection-foreground'], textDecoration: 'none' },
      },
      { dark: theme.colorScheme === 'dark' },
    ),
    syntaxHighlighting(highlight),
  ];
}
