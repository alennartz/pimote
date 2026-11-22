<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { getExtensionEditorHost } from '$lib/stores/extension-editor-host.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CodeEditorDialog from '$lib/components/CodeEditorDialog.svelte';
  import { workspaceKeyId, type EditorWorkspaceKey, type EditorWorkspaceRecord } from '$lib/extension-editor-workspace.js';
  import type { ResolvedEditorLanguage } from '$lib/editor-language.js';

  /**
   * Renders one fullscreen editor dialog per pending editor workspace. Desktop
   * mounts it globally as a session surface; the mobile session page mounts it
   * inline (`flow`) so the editor joins the page scroll flow ahead of the
   * session chip rail.
   */
  let { flow = false }: { flow?: boolean } = $props();

  const editorHost = getExtensionEditorHost();

  let editorWorkspaces = $state<readonly EditorWorkspaceRecord[]>([...editorHost.workspaces]);
  const editorLanguages = new SvelteMap<string, ResolvedEditorLanguage | null>();
  const languageLoads = new SvelteSet<string>();

  let confirmDiscardOpen = $state(false);
  let discardKey = $state<EditorWorkspaceKey | null>(null);

  let activeEditor = $derived.by(() => {
    // The host is an imperative module. Read the reactive snapshot first so
    // Svelte re-evaluates this projection when a request changes.
    editorWorkspaces.length;
    return editorHost.active;
  });

  onMount(() => {
    const syncWorkspaces = () => {
      editorWorkspaces = [...editorHost.workspaces];
    };
    syncWorkspaces();
    return editorHost.subscribe(syncWorkspaces);
  });

  // Language detection remains lazy, but each pending request now owns its
  // result. A late import cannot replace another session's language badge.
  $effect(() => {
    const liveKeys = new Set(editorWorkspaces.map((workspace) => workspaceKeyId(workspace.key)));
    for (const key of editorLanguages.keys()) {
      if (!liveKeys.has(key)) editorLanguages.delete(key);
    }
    for (const workspace of editorWorkspaces) {
      const key = workspaceKeyId(workspace.key);
      if (editorLanguages.has(key) || languageLoads.has(key)) continue;
      languageLoads.add(key);
      editorLanguages.set(key, null);
      void import('$lib/editor-language-resolve.js')
        .then((langMod) => {
          if (liveKeys.has(key)) editorLanguages.set(key, langMod.resolveEditorLanguage(workspace.request.title, workspace.request.prefill));
        })
        .finally(() => languageLoads.delete(key));
    }
  });

  $effect(() => {
    const key = discardKey;
    if (!key) return;
    const stillPending = editorWorkspaces.some((workspace) => workspace.key.sessionId === key.sessionId && workspace.key.requestId === key.requestId);
    const active = activeEditor;
    const stillActive = active?.key.sessionId === key.sessionId && active.key.requestId === key.requestId;
    if (!stillPending || !stillActive) {
      discardKey = null;
      confirmDiscardOpen = false;
    }
  });

  function handleEditorClose(workspace: EditorWorkspaceRecord): void {
    if (workspace.status !== 'pending') return;
    if (workspace.dirty) {
      discardKey = workspace.key;
      confirmDiscardOpen = true;
      return;
    }
    void editorHost.answer(workspace.key, 'cancel');
  }

  function handleEditorInteractOutside(workspace: EditorWorkspaceRecord): void {
    if (workspace.status === 'pending' && !workspace.dirty) void editorHost.answer(workspace.key, 'cancel');
  }

  function handleEditorSave(workspace: EditorWorkspaceRecord): void {
    if (workspace.status === 'pending') void editorHost.answer(workspace.key, 'save');
  }

  function discardAndCancel(): void {
    const key = discardKey;
    discardKey = null;
    confirmDiscardOpen = false;
    if (key) void editorHost.answer(key, 'discard');
  }
</script>

{#each editorWorkspaces as workspace (workspaceKeyId(workspace.key))}
  {@const language = editorLanguages.get(workspaceKeyId(workspace.key))}
  <CodeEditorDialog
    open={activeEditor?.key.sessionId === workspace.key.sessionId && activeEditor?.key.requestId === workspace.key.requestId}
    preserveMount
    sessionSurface
    {flow}
    portalProps={flow ? { disabled: true } : undefined}
    title={workspace.request.title ?? 'Editor'}
    subtitle={workspace.request.message ?? null}
    badge={language?.label ?? null}
    language={language?.id ?? null}
    editorKey={workspaceKeyId(workspace.key)}
    bind:value={() => editorHost.getValue(workspace.key) ?? '', (value: string) => editorHost.setValue(workspace.key, value)}
    onclose={() => handleEditorClose(workspace)}
    oninteractoutside={() => handleEditorInteractOutside(workspace)}
    onsave={() => handleEditorSave(workspace)}
  />
{/each}

<Dialog.Root bind:open={confirmDiscardOpen} onOpenChange={(open) => !open && (discardKey = null)}>
  <Dialog.Content showCloseButton={false} overlayClass="z-[60]" class="z-[60]">
    <Dialog.Header>
      <Dialog.Title>Discard unsaved changes?</Dialog.Title>
      <Dialog.Description>Your edits have not been saved.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (confirmDiscardOpen = false)}>Keep editing</Button>
      <Button variant="destructive" onclick={discardAndCancel}>Discard</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
