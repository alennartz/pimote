import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const pimoteEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'oklch(0.16 0.03 258)',
      color: '#adbac7',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-content': {
      padding: '1rem 0',
      caretColor: 'var(--foreground)',
    },
    '.cm-line': {
      padding: '0 1rem',
    },
    '.cm-gutters': {
      borderRight: '1px solid color-mix(in oklch, var(--border) 92%, #000 8%)',
      backgroundColor: 'oklch(0.145 0.028 258)',
      color: '#768390',
    },
    '.cm-gutterElement': {
      padding: '0 0.75rem 0 0.5rem',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, #6cb6ff 7%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in srgb, #6cb6ff 12%, transparent)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, #316dca 38%, transparent)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--foreground)',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-focused .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, #316dca 44%, transparent)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, #eac55f 28%, transparent)',
      outline: '1px solid color-mix(in srgb, #eac55f 45%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, #f69d50 32%, transparent)',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'color-mix(in srgb, #8ddb8c 16%, transparent)',
      outline: '1px solid color-mix(in srgb, #8ddb8c 28%, transparent)',
    },
    '.cm-tooltip': {
      border: '1px solid var(--border)',
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--accent)',
      color: 'var(--accent-foreground)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'color-mix(in srgb, #768390 14%, transparent)',
      border: '1px solid color-mix(in srgb, #768390 20%, transparent)',
      color: '#768390',
    },
  },
  { dark: true },
);

export const pimoteSyntaxHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: '#f47067' },
  { tag: [t.definitionKeyword, t.moduleKeyword], color: '#f47067' },
  { tag: [t.function(t.variableName), t.labelName, t.className, t.typeName, t.namespace], color: '#dcbdfb' },
  { tag: [t.attributeName, t.propertyName, t.variableName, t.number, t.bool, t.atom, t.standard(t.name)], color: '#6cb6ff' },
  { tag: [t.string, t.special(t.string), t.regexp, t.url, t.escape], color: '#96d0ff' },
  { tag: [t.special(t.variableName), t.constant(t.name), t.color, t.annotation], color: '#f69d50' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#768390', fontStyle: 'italic' },
  { tag: [t.tagName, t.angleBracket, t.bracket], color: '#8ddb8c' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: '#316dca', fontWeight: '700' },
  { tag: [t.emphasis], color: '#adbac7', fontStyle: 'italic' },
  { tag: [t.strong], color: '#adbac7', fontWeight: '700' },
  { tag: [t.meta], color: '#6cb6ff' },
  { tag: [t.separator, t.punctuation, t.derefOperator], color: '#adbac7' },
  { tag: [t.inserted], color: '#b4f1b4', backgroundColor: '#1b4721' },
  { tag: [t.deleted], color: '#ffd8d3', backgroundColor: '#78191b' },
  { tag: [t.invalid], color: '#ffd8d3', textDecoration: 'underline wavy #f47067' },
]);

export const pimoteSyntaxExtension = syntaxHighlighting(pimoteSyntaxHighlightStyle, { fallback: true });
