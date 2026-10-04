<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, Compartment, type Extension } from '@codemirror/state';
  import { EditorView, keymap } from '@codemirror/view';
  import { indentWithTab } from '@codemirror/commands';
  import { basicSetup } from 'codemirror';
  import { githubDarkInit } from '@uiw/codemirror-theme-github';
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
  const layoutTheme = EditorView.theme(
    {
      '&': {
        height: '100%',
      },
      '.cm-editor': {
        height: '100%',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
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
    },
    { dark: true },
  );
  const githubDarkTheme = githubDarkInit({
    settings: {
      fontFamily: 'var(--font-mono)',
    },
  });

  function buildExtensions(languageId: EditorLanguage | null): Extension[] {
    const languageExtension = getCodeMirrorLanguageExtension(languageId);

    return [
      basicSetup,
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      githubDarkTheme,
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

    editorView = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(language),
      }),
      parent: host,
    });

    if (autofocus) {
      editorView.focus();
    }

    return () => {
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
</script>

<div bind:this={host} class="extension-code-editor h-full min-h-0 w-full min-w-0 overflow-hidden"></div>
