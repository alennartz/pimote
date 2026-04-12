<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { PimoteEvent, PimoteTreeNode } from '@pimote/shared';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { setEditorText } from '$lib/stores/input-bar.svelte.js';
  import { treeDialogStore, type TreeFilterMode } from '$lib/stores/tree-dialog.svelte.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Tag from '@lucide/svelte/icons/tag';

  type SummaryMode = 'none' | 'summarize' | 'custom';

  interface TreeRow {
    node: PimoteTreeNode;
    depth: number;
    expanded: boolean;
    hasChildren: boolean;
  }

  interface NavigationSessionState {
    inProgress: boolean;
    summarizing: boolean;
    closeOnResync: boolean;
  }

  interface LabelEditorState {
    nodeId: string;
    value: string;
    x: number;
    y: number;
  }

  const navigationStateBySession = new SvelteMap<string, NavigationSessionState>();

  let summaryMode: SummaryMode = $state('none');
  let customInstructions = $state('');
  let navigating = $state(false);

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressedTapNodeId: string | null = null;

  let labelEditor: LabelEditorState | null = $state(null);
  let labelEditorSaving = $state(false);
  let labelEditorInputEl: HTMLInputElement | null = $state(null);

  const activePath = $derived.by(() => {
    const tree = treeDialogStore.state.tree ?? [];
    const currentLeafId = treeDialogStore.state.currentLeafId;
    if (!currentLeafId) return new Set<string>();
    return new Set(findPathToNode(tree, currentLeafId));
  });

  const treeRows = $derived.by(() => buildTreeRows(treeDialogStore.getFilteredTree(), treeDialogStore.expandedNodeIds, activePath));

  const canNavigate = $derived(
    treeDialogStore.state.open && !!treeDialogStore.state.sessionId && !!treeDialogStore.selectedNodeId && !treeDialogStore.state.loading && !navigating && connection.ready,
  );

  $effect(() => {
    if (!treeDialogStore.state.open) {
      navigating = false;
      labelEditor = null;
      labelEditorSaving = false;
      return;
    }

    summaryMode = 'none';
    customInstructions = '';

    const sessionId = treeDialogStore.state.sessionId;
    if (!sessionId) {
      treeDialogStore.setLoading(false);
      return;
    }

    const navState = navigationStateBySession.get(sessionId);
    treeDialogStore.setLoading(!!navState?.inProgress && navState.summarizing);
  });

  // Close if the user switches to a different viewed session.
  $effect(() => {
    if (!treeDialogStore.state.open) return;
    const dialogSessionId = treeDialogStore.state.sessionId;
    if (!dialogSessionId) return;
    if (sessionRegistry.viewedSessionId !== dialogSessionId) {
      treeDialogStore.closeDialog();
    }
  });

  onMount(() => {
    const unsubscribe = connection.onEvent((event) => {
      handleConnectionEvent(event);
    });

    const onKeydown = (event: KeyboardEvent) => {
      if (!treeDialogStore.state.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (labelEditor) {
          closeLabelEditor();
          return;
        }
        treeDialogStore.closeDialog();
      }
    };

    window.addEventListener('keydown', onKeydown);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeydown);
      clearLongPressTimer();
    };
  });

  function findPathToNode(nodes: PimoteTreeNode[], targetId: string): string[] {
    for (const node of nodes) {
      if (node.id === targetId) return [node.id];
      const childPath = findPathToNode(node.children, targetId);
      if (childPath.length > 0) {
        return [node.id, ...childPath];
      }
    }
    return [];
  }

  function buildTreeRows(nodes: PimoteTreeNode[], expandedNodeIds: Set<string>, activePathNodes: Set<string>, depth = 0): TreeRow[] {
    const rows: TreeRow[] = [];

    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && (expandedNodeIds.has(node.id) || activePathNodes.has(node.id));

      rows.push({ node, depth, expanded, hasChildren });

      if (expanded) {
        rows.push(...buildTreeRows(node.children, expandedNodeIds, activePathNodes, depth + 1));
      }
    }

    return rows;
  }

  function setNavigationState(sessionId: string, next: NavigationSessionState): void {
    navigationStateBySession.set(sessionId, next);
  }

  function clearCloseOnResync(sessionId: string): void {
    const existing = navigationStateBySession.get(sessionId);
    if (!existing) return;
    setNavigationState(sessionId, {
      ...existing,
      inProgress: false,
      summarizing: false,
      closeOnResync: false,
    });
  }

  function handleConnectionEvent(event: PimoteEvent): void {
    if (!('sessionId' in event) || typeof event.sessionId !== 'string') return;

    const eventSessionId = event.sessionId;

    if (event.type === 'tree_navigation_start') {
      setNavigationState(eventSessionId, {
        inProgress: true,
        summarizing: event.summarizing,
        closeOnResync: false,
      });

      if (treeDialogStore.state.open && treeDialogStore.state.sessionId === eventSessionId && event.summarizing) {
        treeDialogStore.setLoading(true);
      }
      return;
    }

    if (event.type === 'tree_navigation_end') {
      setNavigationState(eventSessionId, {
        inProgress: false,
        summarizing: false,
        closeOnResync: true,
      });

      if (treeDialogStore.state.open && treeDialogStore.state.sessionId === eventSessionId) {
        treeDialogStore.setLoading(false);
      }
      return;
    }

    if (event.type === 'full_resync') {
      const navState = navigationStateBySession.get(eventSessionId);
      if (!navState) return;

      if (navState.closeOnResync) {
        navigationStateBySession.delete(eventSessionId);
        if (treeDialogStore.state.open && treeDialogStore.state.sessionId === eventSessionId) {
          treeDialogStore.closeDialog();
        }
      } else if (treeDialogStore.state.open && treeDialogStore.state.sessionId === eventSessionId && navState.inProgress && navState.summarizing) {
        treeDialogStore.setLoading(true);
      }
    }
  }

  function clearLongPressTimer(): void {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function openLabelEditor(node: PimoteTreeNode, x: number, y: number): void {
    const popoverWidth = 320;
    const popoverHeight = 180;
    const clampedX = Math.max(8, Math.min(x, window.innerWidth - popoverWidth - 8));
    const clampedY = Math.max(8, Math.min(y, window.innerHeight - popoverHeight - 8));

    labelEditor = {
      nodeId: node.id,
      value: node.label ?? '',
      x: clampedX,
      y: clampedY,
    };

    labelEditorSaving = false;
    queueMicrotask(() => {
      labelEditorInputEl?.focus();
      labelEditorInputEl?.select();
    });
  }

  function closeLabelEditor(): void {
    labelEditor = null;
    labelEditorSaving = false;
  }

  function onNodeContextMenu(event: MouseEvent, node: PimoteTreeNode): void {
    event.preventDefault();
    openLabelEditor(node, event.clientX, event.clientY);
  }

  function onNodePointerDown(event: PointerEvent, node: PimoteTreeNode): void {
    if (event.pointerType !== 'touch') return;
    const { clientX, clientY } = event;
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      suppressedTapNodeId = node.id;
      openLabelEditor(node, clientX, clientY);
      clearLongPressTimer();
    }, 500);
  }

  function onNodePointerUp(): void {
    clearLongPressTimer();
  }

  function onNodePointerCancel(): void {
    clearLongPressTimer();
  }

  async function saveNodeLabel(): Promise<void> {
    const sessionId = treeDialogStore.state.sessionId;
    const editor = labelEditor;
    if (!sessionId || !editor || labelEditorSaving) return;

    labelEditorSaving = true;
    const trimmed = editor.value.trim();
    const label = trimmed.length > 0 ? trimmed : undefined;

    try {
      const response = await connection.send({
        type: 'set_tree_label',
        sessionId,
        entryId: editor.nodeId,
        label,
      });
      if (response.success) {
        treeDialogStore.setNodeLabel(editor.nodeId, label);
        closeLabelEditor();
      }
    } catch (error) {
      console.error('Failed to set tree label:', error);
    } finally {
      labelEditorSaving = false;
    }
  }

  function selectNode(nodeId: string): void {
    if (suppressedTapNodeId === nodeId) {
      suppressedTapNodeId = null;
      return;
    }

    if (treeDialogStore.selectedNodeId === nodeId && canNavigate) {
      void navigateSelectedNode();
      return;
    }

    treeDialogStore.setSelectedNode(nodeId);
  }

  function toggleNodeExpanded(nodeId: string): void {
    treeDialogStore.toggleExpanded(nodeId);
  }

  function setFilterMode(mode: TreeFilterMode): void {
    treeDialogStore.setFilterMode(mode);
  }

  async function navigateSelectedNode(): Promise<void> {
    const sessionId = treeDialogStore.state.sessionId;
    const targetId = treeDialogStore.selectedNodeId;

    if (!sessionId || !targetId || treeDialogStore.state.loading || navigating) return;

    const summarize = summaryMode !== 'none';

    try {
      navigating = true;
      treeDialogStore.setLoading(summarize);

      const response = await connection.send({
        type: 'navigate_tree',
        sessionId,
        targetId,
        ...(summarize ? { summarize: true } : {}),
        ...(summaryMode === 'custom' ? { customInstructions } : {}),
        ...(summaryMode === 'custom' ? { replaceInstructions: false } : {}),
      });

      treeDialogStore.setLoading(false);

      if (!response.success || !response.data) {
        clearCloseOnResync(sessionId);
        return;
      }

      const result = response.data as { cancelled?: boolean; editorText?: string };
      if (result.cancelled) {
        clearCloseOnResync(sessionId);
        return;
      }

      if (typeof result.editorText === 'string' && result.editorText.length > 0) {
        setEditorText(sessionId, result.editorText);
      }

      treeDialogStore.closeDialog();
    } catch (error) {
      clearCloseOnResync(sessionId);
      treeDialogStore.setLoading(false);
      console.error('Failed to navigate tree:', error);
    } finally {
      navigating = false;
    }
  }
</script>

{#if treeDialogStore.state.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 bg-black/60" onclick={() => treeDialogStore.closeDialog()} onkeydown={(e) => e.key === 'Escape' && treeDialogStore.closeDialog()}>
    <div
      class="bg-background fixed top-0 left-0 z-[60] flex h-dvh w-screen max-w-none flex-col rounded-none border shadow-xl sm:top-1/2 sm:left-1/2 sm:h-[min(92dvh,960px)] sm:w-[min(96vw,1080px)] sm:max-w-[min(96vw,1080px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <header
        class="border-border bg-background/95 flex shrink-0 flex-col gap-3 border-b px-4 py-3 backdrop-blur sm:px-5"
        style="padding-top: max(0.75rem, env(safe-area-inset-top));"
      >
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-foreground text-base font-semibold">Tree Navigation</h2>
          <button class="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-sm" onclick={() => treeDialogStore.closeDialog()}> Close </button>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row">
          <input
            class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring w-full rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
            type="text"
            placeholder="Search previews..."
            value={treeDialogStore.state.searchQuery}
            oninput={(e) => treeDialogStore.setSearchQuery((e.currentTarget as HTMLInputElement).value)}
          />

          <select
            class="border-border bg-secondary text-foreground focus:border-ring focus:ring-ring rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
            value={treeDialogStore.state.filterMode}
            onchange={(e) => setFilterMode((e.currentTarget as HTMLSelectElement).value as TreeFilterMode)}
          >
            <option value="default">Default</option>
            <option value="user-only">User only</option>
            <option value="all">All</option>
            <option value="labeled-only">Labeled only</option>
          </select>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-3">
        {#if treeRows.length === 0}
          <div class="text-muted-foreground px-3 py-6 text-sm">No tree nodes match the current filter.</div>
        {:else}
          <div class="space-y-1">
            {#each treeRows as row (row.node.id)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="border-border/60 hover:bg-accent/60 flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors
                  {treeDialogStore.selectedNodeId === row.node.id ? 'ring-ring bg-accent ring-1' : ''}
                  {activePath.has(row.node.id) ? 'border-primary/40' : ''}"
                style={`margin-left: ${row.depth * 14}px`}
                tabindex="0"
                onclick={() => selectNode(row.node.id)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectNode(row.node.id);
                  }
                }}
                oncontextmenu={(e) => onNodeContextMenu(e, row.node)}
                onpointerdown={(event) => onNodePointerDown(event, row.node)}
                onpointerup={onNodePointerUp}
                onpointercancel={onNodePointerCancel}
                onpointerleave={onNodePointerCancel}
              >
                {#if row.hasChildren}
                  <button
                    class="text-muted-foreground hover:text-foreground mt-0.5 rounded p-0.5"
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleNodeExpanded(row.node.id);
                    }}
                    title={row.expanded ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight class={`size-4 transition-transform ${row.expanded ? 'rotate-90' : ''}`} />
                  </button>
                {:else}
                  <span class="inline-block size-5"></span>
                {/if}

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-[11px] uppercase">{row.node.type}</span>
                    {#if row.node.role}
                      <span class="text-muted-foreground shrink-0 text-[11px]">{row.node.role}</span>
                    {/if}
                    {#if row.node.id === treeDialogStore.state.currentLeafId}
                      <span class="bg-primary/15 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">active</span>
                    {/if}
                    {#if row.node.label}
                      <span class="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]">
                        <Tag class="size-2.5" />
                        {row.node.label}
                      </span>
                    {/if}
                  </div>
                  <div class="text-foreground mt-0.5 break-words">{row.node.preview}</div>
                  <div class="text-muted-foreground mt-0.5 text-[11px]" title={row.node.timestamp}>{formatRelativeTime(row.node.timestamp)}</div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <footer
        class="border-border bg-background/95 flex shrink-0 flex-col gap-3 border-t px-4 py-3 backdrop-blur sm:px-5"
        style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom));"
      >
        <div class="flex flex-wrap gap-2">
          <button
            class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
              {summaryMode === 'none' ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
            onclick={() => (summaryMode = 'none')}
          >
            No summary
          </button>
          <button
            class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
              {summaryMode === 'summarize' ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
            onclick={() => (summaryMode = 'summarize')}
          >
            Summarize
          </button>
          <button
            class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
              {summaryMode === 'custom' ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}"
            onclick={() => (summaryMode = 'custom')}
          >
            Custom summary prompt
          </button>
        </div>

        {#if summaryMode === 'custom'}
          <textarea
            class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring min-h-20 w-full resize-y rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
            placeholder="Custom summarization instructions..."
            bind:value={customInstructions}
          ></textarea>
        {/if}

        <div class="flex items-center justify-between gap-2">
          <button class="border-border hover:bg-accent rounded-md border px-3 py-2 text-sm" onclick={() => treeDialogStore.closeDialog()}>Cancel</button>
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canNavigate}
            onclick={navigateSelectedNode}
          >
            Navigate
          </button>
        </div>

        {#if treeDialogStore.state.loading}
          <div class="text-muted-foreground text-xs">Summarizing and navigating…</div>
        {/if}
      </footer>
    </div>

    {#if labelEditor}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="fixed inset-0 z-[80]"
        tabindex="0"
        onclick={(event) => {
          event.stopPropagation();
          closeLabelEditor();
        }}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            closeLabelEditor();
          }
        }}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          class="bg-background border-border fixed w-80 rounded-lg border p-3 shadow-xl"
          style={`left: ${labelEditor.x}px; top: ${labelEditor.y}px`}
          onclick={(event) => event.stopPropagation()}
          onsubmit={(event) => {
            event.preventDefault();
            void saveNodeLabel();
          }}
        >
          <label class="text-foreground mb-2 block text-xs font-medium" for="tree-label-input">Label</label>
          <input
            id="tree-label-input"
            class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring w-full rounded-md border px-2.5 py-2 text-sm focus:ring-1 focus:outline-none"
            type="text"
            value={labelEditor.value}
            placeholder="Set label (leave blank to clear)"
            bind:this={labelEditorInputEl}
            oninput={(event) => {
              if (!labelEditor) return;
              labelEditor = {
                ...labelEditor,
                value: (event.currentTarget as HTMLInputElement).value,
              };
            }}
          />

          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="border-border hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs" onclick={closeLabelEditor}>Cancel</button>
            <button
              type="submit"
              class="bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              disabled={labelEditorSaving}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    {/if}
  </div>
{/if}
