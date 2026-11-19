<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, Compartment, type Extension } from '@codemirror/state';
  import { EditorView, keymap } from '@codemirror/view';
  import { indentWithTab } from '@codemirror/commands';
  import { basicSetup } from 'codemirror';
  import type { ResolvedTheme } from '@pimote/shared';
  import { createCodeMirrorTheme } from '$lib/codemirror-theme.js';
  import { themeRuntime } from '$lib/theme-runtime.svelte.js';
  import { getCodeMirrorLanguageExtension } from '$lib/codemirror-language.js';
  import type { EditorLanguage } from '$lib/editor-language.js';

  let {
    value = $bindable(''),
    language = null,
    autofocus = true,
    editorView = $bindable<EditorView | null>(null),
  }: {
    value?: string;
    language?: EditorLanguage | null;
    autofocus?: boolean;
    /** Seam for toolbars: the live CodeMirror view (selection + transactions). */
    editorView?: EditorView | null;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let syncingFromView = false;

  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const surfaceRoles = [
    'background',
    'foreground',
    'selection',
    'cursor',
    'active-line',
    'gutter-background',
    'gutter-foreground',
    'line-number',
    'active-line-number',
    'matching-bracket',
    'search-match',
    'diff-addition-background',
    'diff-deletion-background',
  ] as const;
  const syntaxRoles = [
    'comment',
    'doc-comment',
    'name',
    'variable',
    'parameter',
    'type',
    'tag',
    'property',
    'attribute',
    'class',
    'label',
    'namespace',
    'macro',
    'constant',
    'function',
    'built-in',
    'keyword',
    'control-keyword',
    'definition-keyword',
    'modifier',
    'operator-keyword',
    'operator',
    'punctuation',
    'separator',
    'bracket',
    'string',
    'doc-string',
    'character',
    'attribute-value',
    'number',
    'boolean',
    'null',
    'regexp',
    'escape',
    'color',
    'url',
    'content',
    'heading',
    'content-separator',
    'list',
    'quote',
    'emphasis',
    'strong',
    'link',
    'monospace',
    'strikethrough',
    'inserted',
    'deleted',
    'changed',
    'invalid',
    'meta',
    'document-meta',
    'annotation',
    'processing-instruction',
  ] as const;
  const terminalRoles = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'bright-black',
    'bright-red',
    'bright-green',
    'bright-yellow',
    'bright-blue',
    'bright-magenta',
    'bright-cyan',
    'bright-white',
  ] as const;

  function cssTheme(): ResolvedTheme {
    const map = (prefix: string, roles: readonly string[]): Record<string, string> => Object.fromEntries([...roles].map((role) => [role, `var(--pimote-${prefix}-${role})`]));
    const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return {
      id: 'runtime/css',
      name: 'Runtime',
      source: 'builtin',
      colorScheme: dark ? 'dark' : 'light',
      ui: {} as ResolvedTheme['ui'],
      editor: {
        surface: map('editor', surfaceRoles) as ResolvedTheme['editor']['surface'],
        syntax: map('editor', syntaxRoles) as ResolvedTheme['editor']['syntax'],
        terminal: map('terminal', terminalRoles) as ResolvedTheme['editor']['terminal'],
      },
    };
  }

  let effectiveTheme = $derived(themeRuntime.activeTheme ?? cssTheme());

  function buildExtensions(languageId: EditorLanguage | null, theme: ResolvedTheme): Extension[] {
    const languageExtension = getCodeMirrorLanguageExtension(languageId);
    const layoutTheme = EditorView.theme({
      '&': {
        height: '100%',
      },
      '.cm-editor': {
        height: '100%',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        // JetBrains Mono Variable shapes `--` / `!!` as spacer+ligature pairs;
        // renderers that clip ligature ink to its advance drop the first
        // character visually. Command text must stay verbatim.
        fontVariantLigatures: 'none',
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '1rem 0',
      },
      '.cm-line': {
        padding: '0 1rem',
      },
      '.cm-gutterElement': {
        padding: '0 0.75rem 0 0.5rem',
      },
      '.cm-focused': {
        outline: 'none',
      },
    });
    return [
      basicSetup,
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      themeCompartment.of(createCodeMirrorTheme(theme)),
      layoutTheme,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        syncingFromView = true;
        value = update.state.doc.toString();
        syncingFromView = false;
      }),
      languageCompartment.of(languageExtension ?? []),
    ];
  }

  onMount(() => {
    if (!host) return;
    const editorHost = host;

    editorView = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(language, effectiveTheme),
      }),
      parent: editorHost,
    });

    // CodeMirror handles Escape itself when an editor panel is open. Its
    // keymaps prevent the default action but do not stop the event from
    // reaching bits-ui's document-level Escape listener. Stop propagation only
    // after CodeMirror marks the actual event handled.
    const stopHandledEditorEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && event.defaultPrevented) {
        event.stopPropagation();
      }
    };
    editorHost.addEventListener('keydown', stopHandledEditorEscape);

    if (autofocus) {
      editorView.focus();
    }

    return () => {
      editorHost.removeEventListener('keydown', stopHandledEditorEscape);
      editorView?.destroy();
      editorView = null;
    };
  });

  $effect(() => {
    if (!editorView || syncingFromView) return;

    const currentDoc = editorView.state.doc.toString();
    if (currentDoc === value) return;

    editorView.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: value },
    });
  });

  $effect(() => {
    if (!editorView) return;

    editorView.dispatch({
      effects: languageCompartment.reconfigure(getCodeMirrorLanguageExtension(language) ?? []),
    });
  });

  $effect(() => {
    const theme = effectiveTheme;
    if (!editorView) return;
    editorView.dispatch({ effects: themeCompartment.reconfigure(createCodeMirrorTheme(theme)) });
  });
</script>

<div bind:this={host} class="extension-code-editor h-full min-h-0 w-full min-w-0 overflow-hidden"></div>
