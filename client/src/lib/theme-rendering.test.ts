// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { SYNTAX_SCOPES, editorPropertyName, type AnsiColorName, type ResolvedTheme } from '@pimote/shared';
import { resolvedTheme } from '../../../shared/test/theme-fixtures.js';
import { ansiToHtml } from './ansi-to-html.js';
import { ensureHljs, highlightToHtml } from './code-highlight.js';
import { createCodeMirrorTheme } from './codemirror-theme.js';

const highlightStyles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'highlight-theme.css'), 'utf8');

const hosts: HTMLElement[] = [];
const styleElements: HTMLStyleElement[] = [];

function host(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  hosts.push(element);
  return element;
}

function installThemeVariables(theme: ResolvedTheme): void {
  for (const [role, value] of Object.entries(theme.editor.surface)) {
    document.documentElement.style.setProperty(`--pimote-editor-${role}`, value);
  }
  for (const scope of SYNTAX_SCOPES) {
    document.documentElement.style.setProperty(editorPropertyName(scope), theme.editor.syntax[scope]);
  }
  for (const [role, value] of Object.entries(theme.editor.terminal)) {
    document.documentElement.style.setProperty(`--pimote-terminal-${role}`, value);
  }
}

function cssColor(value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  return probe.style.color;
}

function renderedColor(element: Element, property: 'color' | 'background-color' = 'color'): string {
  const style = getComputedStyle(element);
  let value = style.getPropertyValue(property).trim();
  if (property === 'background-color' && style.background.trim().startsWith('var(')) value = style.background.trim();
  const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value);
  if (variable) value = getComputedStyle(document.documentElement).getPropertyValue(variable[1]).trim() || variable[2] || '';
  return cssColor(value);
}

function tokenElement(root: HTMLElement, text: string): Element {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent?.includes(text)) return walker.currentNode.parentElement!;
  }
  throw new Error(`Text not rendered: ${text}`);
}

function codeTheme(id: string, background: string, comment: string, string: string, number: string): ResolvedTheme {
  const theme = resolvedTheme(id);
  theme.editor.surface.background = background;
  theme.editor.syntax.comment = comment;
  theme.editor.syntax['string.quoted'] = string;
  theme.editor.syntax['constant.numeric'] = number;
  return theme;
}

const light = codeTheme('test/light', '#f1f2f3', '#123456', '#234567', '#345678');
const dark = codeTheme('test/dark', '#101112', '#abcdef', '#bcdef0', '#cdef01');
const code = '// note\nconst value = "hello";\nconst count = 42;';

function expectSyntaxColors(root: HTMLElement, theme: ResolvedTheme): void {
  for (const [text, scope] of [
    ['// note', 'comment'],
    ['"hello"', 'string.quoted'],
    ['42', 'constant.numeric'],
  ] as const) {
    expect(renderedColor(tokenElement(root, text)), scope).toBe(cssColor(theme.editor.syntax[scope]));
  }
}

afterEach(() => {
  for (const element of hosts.splice(0)) element.remove();
  for (const element of styleElements.splice(0)) element.remove();
  document.documentElement.removeAttribute('style');
});

describe('CodeMirror theme rendering', () => {
  it('renders syntax and surface colors and updates a live editor when the theme changes', () => {
    const parent = host();
    const compartment = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: code, extensions: [javascript(), compartment.of(createCodeMirrorTheme(light))] }),
    });
    try {
      expect(renderedColor(view.dom, 'background-color')).toBe(cssColor(light.editor.surface.background));
      expectSyntaxColors(view.dom, light);

      view.dispatch({ effects: compartment.reconfigure(createCodeMirrorTheme(dark)) });
      expect(view.state.doc.toString()).toBe(code);
      expect(renderedColor(view.dom, 'background-color')).toBe(cssColor(dark.editor.surface.background));
      expectSyntaxColors(view.dom, dark);
    } finally {
      view.destroy();
    }
  });

  it('renders markdown prose in the editor foreground and inline code in markup.raw', () => {
    const theme = resolvedTheme('test/markdown');
    theme.editor.surface.foreground = '#0a0b0c';
    theme.editor.syntax['markup.raw'] = '#7b2d8e';
    const parent = host();
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'plain words\n\nSmall `code span` here.\n', extensions: [markdown(), createCodeMirrorTheme(theme)] }),
    });
    try {
      expect(renderedColor(tokenElement(view.contentDOM, 'plain words'))).toBe(cssColor(theme.editor.surface.foreground));
      expect(renderedColor(tokenElement(view.contentDOM, 'code span'))).toBe(cssColor(theme.editor.syntax['markup.raw']));
    } finally {
      view.destroy();
    }
  });

  it('uses an underline for search matches and selection for the selected match', () => {
    const parent = host();
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'match selected', extensions: [createCodeMirrorTheme(light)] }),
    });
    const match = document.createElement('span');
    match.className = 'cm-searchMatch';
    match.textContent = 'match';
    const selected = document.createElement('span');
    selected.className = 'cm-searchMatch cm-searchMatch-selected';
    selected.textContent = 'selected';
    view.contentDOM.append(match, selected);
    try {
      const matchStyle = getComputedStyle(match);
      expect(matchStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(matchStyle.textDecoration).toContain('underline');
      expect(renderedColor(selected, 'background-color')).toBe(cssColor(light.editor.surface.selection));
      expect(renderedColor(selected)).toBe(cssColor(light.editor.surface['selection-foreground']));
      expect(getComputedStyle(selected).textDecoration).toBe('none');
    } finally {
      view.destroy();
    }
  });

  it('overrides CodeMirror’s focused selection layer with the theme selection color', () => {
    const parent = host();
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'selected text', extensions: [createCodeMirrorTheme(light)] }),
    });
    const layer = document.createElement('div');
    layer.className = 'cm-selectionLayer';
    const selection = document.createElement('div');
    selection.className = 'cm-selectionBackground';
    layer.append(selection);
    view.dom.querySelector('.cm-scroller')!.append(layer);
    view.dom.classList.add('cm-focused');
    try {
      expect(renderedColor(selection, 'background-color')).toBe(cssColor(light.editor.surface.selection));
    } finally {
      view.destroy();
    }
  });

  it('updates the editor color scheme when reconfigured', () => {
    const parent = host();
    const compartment = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({ extensions: [compartment.of(createCodeMirrorTheme(light))] }),
    });
    try {
      expect(view.state.facet(EditorView.darkTheme)).toBe(false);
      view.dispatch({ effects: compartment.reconfigure(createCodeMirrorTheme(dark)) });
      expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe('Highlight.js theme rendering', () => {
  it('renders the same syntax roles and updates existing code when theme variables change', async () => {
    const style = document.createElement('style');
    style.textContent = highlightStyles;
    document.head.append(style);
    styleElements.push(style);
    const parent = host();
    const element = document.createElement('code');
    element.classList.add('hljs');
    parent.append(element);
    await ensureHljs();
    element.innerHTML = highlightToHtml(code, 'javascript');
    expect(element.textContent).toBe(code);

    installThemeVariables(light);
    expect(renderedColor(element, 'background-color')).toBe(cssColor(light.editor.surface.background));
    expectSyntaxColors(element, light);

    installThemeVariables(dark);
    expect(renderedColor(element, 'background-color')).toBe(cssColor(dark.editor.surface.background));
    expectSyntaxColors(element, dark);
  });
});

const terminalSlots: Array<{ role: AnsiColorName; foreground: number; background: number }> = [
  { role: 'black', foreground: 30, background: 40 },
  { role: 'red', foreground: 31, background: 41 },
  { role: 'green', foreground: 32, background: 42 },
  { role: 'yellow', foreground: 33, background: 43 },
  { role: 'blue', foreground: 34, background: 44 },
  { role: 'magenta', foreground: 35, background: 45 },
  { role: 'cyan', foreground: 36, background: 46 },
  { role: 'white', foreground: 37, background: 47 },
  { role: 'bright-black', foreground: 90, background: 100 },
  { role: 'bright-red', foreground: 91, background: 101 },
  { role: 'bright-green', foreground: 92, background: 102 },
  { role: 'bright-yellow', foreground: 93, background: 103 },
  { role: 'bright-blue', foreground: 94, background: 104 },
  { role: 'bright-magenta', foreground: 95, background: 105 },
  { role: 'bright-cyan', foreground: 96, background: 106 },
  { role: 'bright-white', foreground: 97, background: 107 },
];

function terminalTheme(id: string, offset: number): ResolvedTheme {
  const theme = resolvedTheme(id);
  terminalSlots.forEach(({ role }, index) => {
    theme.editor.terminal[role] = `#${(offset + index).toString(16).padStart(6, '0')}`;
  });
  return theme;
}

const terminalLight = terminalTheme('test/terminal-light', 0x123400);
const terminalDark = terminalTheme('test/terminal-dark', 0x567800);

function ansiElement(parent: HTMLElement, sequence: string): Element {
  parent.innerHTML = ansiToHtml(`${sequence}sample\u001b[0m`);
  expect(parent.textContent).toBe('sample');
  return tokenElement(parent, 'sample');
}

describe('ANSI theme rendering', () => {
  for (const slot of terminalSlots) {
    for (const [kind, property] of [
      ['foreground', 'color'],
      ['background', 'background-color'],
    ] as const) {
      it(`renders ${slot.role} ${kind} from the active terminal palette`, () => {
        const parent = host();
        installThemeVariables(terminalLight);
        const element = ansiElement(parent, `\u001b[${slot[kind]}m`);
        expect(renderedColor(element, property)).toBe(cssColor(terminalLight.editor.terminal[slot.role]));
        installThemeVariables(terminalDark);
        expect(renderedColor(element, property)).toBe(cssColor(terminalDark.editor.terminal[slot.role]));
      });
    }
  }

  for (const [code, property] of [
    [38, 'color'],
    [48, 'background-color'],
  ] as const) {
    it(`preserves every indexed 256-color ${property} across themes`, () => {
      const parent = host();
      const originalBase = [
        '#000000',
        '#aa0000',
        '#00aa00',
        '#aa5500',
        '#0000aa',
        '#aa00aa',
        '#00aaaa',
        '#aaaaaa',
        '#555555',
        '#ff5555',
        '#55ff55',
        '#ffff55',
        '#5555ff',
        '#ff55ff',
        '#55ffff',
        '#ffffff',
      ];
      const cube = [0, 95, 135, 175, 215, 255];
      const sampleFor = (index: number) => index.toString().padStart(3, '0');
      for (const theme of [terminalLight, terminalDark]) {
        installThemeVariables(theme);
        const samples = Array.from({ length: 256 }, (_, index) => sampleFor(index));
        parent.innerHTML = ansiToHtml(samples.map((sample, index) => `\u001b[${code};5;${index}m${sample}\u001b[0m`).join(''));
        expect(parent.textContent).toBe(samples.join(''));

        for (let index = 0; index < 256; index++) {
          let expected: string;
          if (index < 16) expected = originalBase[index];
          else if (index < 232) {
            const n = index - 16;
            expected = `rgb(${cube[Math.floor(n / 36)]}, ${cube[Math.floor(n / 6) % 6]}, ${cube[n % 6]})`;
          } else {
            const level = 8 + (index - 232) * 10;
            expected = `rgb(${level}, ${level}, ${level})`;
          }
          const element = tokenElement(parent, sampleFor(index));
          expect(renderedColor(element, property), `index ${index} in ${theme.id}`).toBe(cssColor(expected));
        }
      }
    });
  }
});
