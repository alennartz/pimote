<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { PimoteTreeNode } from '@pimote/shared';
  import { branchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { buildBranchMap, type BranchMapRow } from '$lib/branch-tree.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Tag from '@lucide/svelte/icons/tag';
  import Plus from '@lucide/svelte/icons/plus';

  const PREVIEW_CLAMP_THRESHOLD = 160;

  let frameEl: HTMLDivElement | null = $state(null);
  let labelInputEl: HTMLInputElement | null = $state(null);
  let editingLabelId: string | null = $state(null);
  let editingLabelValue = $state('');
  let savingLabelId: string | null = $state(null);
  let expandedMessageIds = new SvelteSet<string>();
  let compactionOpen = $state(false);
  let compactionPrompt = $state('');

  const rows = $derived.by(() =>
    branchTreeStore.state.open ? buildRows(branchTreeStore.state.tree, branchTreeStore.state.currentLeafId, branchTreeStore.state.expandedSegmentIds) : [],
  );
  const selectedId = $derived(branchTreeStore.state.selectedId);
  const searchMatches = $derived(branchTreeStore.state.searchMatches);
  const matchingIds = $derived(new Set(searchMatches.map((match) => match.messageKey)));
  const selectedNode = $derived.by(() => findNode(branchTreeStore.state.tree, selectedId));
  const canResume = $derived(
    branchTreeStore.state.open &&
      selectedId !== null &&
      selectedNode !== null &&
      selectedNode.type === 'message' &&
      (selectedNode.role === 'user' || selectedNode.role === 'assistant') &&
      !branchTreeStore.state.busy &&
      branchTreeStore.state.sessionId !== null,
  );
  const showFullSearch = $derived(branchTreeStore.state.searchQuery.trim().length > 0 && branchTreeStore.state.searchScope === 'anchors' && searchMatches.length === 0);
  const scopeLabel = $derived(
    branchTreeStore.state.searchQuery.trim().length === 0 ? 'anchors' : `${branchTreeStore.state.searchScope === 'all' ? 'all messages' : 'anchors'} · ${searchMatches.length}`,
  );
  const expandedSegments = $derived([...branchTreeStore.state.expandedSegmentIds]);

  $effect(() => {
    if (!branchTreeStore.state.open) {
      editingLabelId = null;
      compactionOpen = false;
      return;
    }
    const sessionId = branchTreeStore.state.sessionId;
    if (sessionId && sessionRegistry.viewedSessionId !== sessionId) branchTreeStore.close();
  });

  $effect(() => {
    const open = branchTreeStore.state.open;
    const targetId = branchTreeStore.state.selectedId;
    if (!open || !targetId) return;
    void tick().then(() => {
      if (!frameEl || !branchTreeStore.state.open || branchTreeStore.state.selectedId !== targetId) return;
      const target = Array.from(frameEl.querySelectorAll<HTMLElement>('[data-entry-id]')).find((element) => element.dataset.entryId === targetId);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  onMount(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (!branchTreeStore.state.open || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (editingLabelId !== null) {
          cancelLabelEdit();
          return;
        }
        if (compactionOpen) {
          cancelCompaction();
          return;
        }
        branchTreeStore.close();
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  function findNode(tree: readonly PimoteTreeNode[], id: string | null): PimoteTreeNode | null {
    if (!id) return null;
    const pending = [...tree].reverse();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.id === id) return node;
      for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]);
    }
    return null;
  }

  function buildRows(tree: PimoteTreeNode[], leafId: string | null, expanded: ReadonlySet<string>): BranchMapRow[] {
    return buildBranchMap(tree, leafId, expanded);
  }

  function isExpandedSegmentBefore(row: BranchMapRow): string | null {
    if (row.kind !== 'message') return null;
    const prefix = `segment:${row.id}:`;
    return expandedSegments.find((segmentId) => segmentId.startsWith(prefix)) ?? null;
  }

  function selectMessage(id: string): void {
    branchTreeStore.select(id);
  }

  function toggleSegment(id: string): void {
    branchTreeStore.toggleSegment(id);
  }

  function toggleMessagePreview(id: string): void {
    if (expandedMessageIds.has(id)) expandedMessageIds.delete(id);
    else expandedMessageIds.add(id);
  }

  function beginLabelEdit(id: string, value = ''): void {
    editingLabelId = id;
    editingLabelValue = value;
    queueMicrotask(() => {
      labelInputEl?.focus();
      labelInputEl?.select();
    });
  }

  function beginNodeLabelEdit(row: BranchMapRow): void {
    if (row.kind !== 'message') return;
    beginLabelEdit(row.id, row.label ?? '');
  }

  function cancelLabelEdit(): void {
    editingLabelId = null;
    editingLabelValue = '';
  }

  async function commitLabel(id: string): Promise<void> {
    if (editingLabelId !== id || savingLabelId === id) return;
    const value = editingLabelValue.trim();
    editingLabelId = null;
    editingLabelValue = '';
    savingLabelId = id;
    try {
      await branchTreeStore.setLabel(id, value.length > 0 ? value : undefined);
    } finally {
      savingLabelId = null;
    }
  }

  function handleLabelKeydown(event: KeyboardEvent, id: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitLabel(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelLabelEdit();
    }
  }

  function openCompaction(): void {
    if (!canResume) return;
    compactionPrompt = '';
    compactionOpen = true;
  }

  function cancelCompaction(): void {
    compactionOpen = false;
    compactionPrompt = '';
  }

  async function resume(compactionPromptValue?: string): Promise<void> {
    if (!canResume || !selectedId) return;
    const sessionId = branchTreeStore.state.sessionId;
    if (!sessionId) return;
    const result = await branchTreeStore.navigate(selectedId, compactionPromptValue === undefined ? undefined : { compactionPrompt: compactionPromptValue });
    if (result && !result.cancelled && typeof result.editorText === 'string') {
      const surface = branchTreeStore.state.surface;
      if (surface) sessionRegistry.setSubagentDraftText(surface.rootSessionId, surface.path, result.editorText);
      else sessionRegistry.setDraftText(sessionId, result.editorText);
    }
  }

  async function submitCompaction(): Promise<void> {
    const prompt = compactionPrompt;
    cancelCompaction();
    await resume(prompt);
  }

  function closeExplorer(): void {
    branchTreeStore.close();
  }

  function handleFrameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (editingLabelId !== null) {
        cancelLabelEdit();
      } else if (compactionOpen) {
        cancelCompaction();
      } else {
        closeExplorer();
      }
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
  }
</script>

{#if branchTreeStore.state.open}
  <div class="explorer-overlay" role="presentation" onclick={closeExplorer} onkeydown={(event) => event.key === 'Escape' && closeExplorer()}>
    <div class="explorer-frame" role="dialog" aria-modal="true" aria-label="Branches" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={handleFrameKeydown}>
      <header class="explorer-header">
        <div class="explorer-title-row">
          <strong>Branches</strong>
          <button type="button" class="text-button" onclick={() => branchTreeStore.close()}>Close</button>
        </div>
        <div class="search-row">
          <input
            aria-label="Search branch points"
            placeholder="Search branch points…"
            value={branchTreeStore.state.searchQuery}
            oninput={(event) => branchTreeStore.setSearch((event.currentTarget as HTMLInputElement).value)}
          />
          <span class="scope-chip">{scopeLabel}</span>
        </div>
        {#if showFullSearch}
          <div class="search-notice" role="status">
            No branch-point matches.
            <button type="button" class="small-button" onclick={() => branchTreeStore.searchAll(branchTreeStore.state.searchQuery)}>Search all messages</button>
          </div>
        {/if}
      </header>

      <div bind:this={frameEl} class="explorer-tree" tabindex="-1">
        {#if branchTreeStore.state.error}
          <div class="error-message" role="alert">{branchTreeStore.state.error}</div>
        {/if}
        {#if branchTreeStore.state.tree.length === 0 && !branchTreeStore.state.error}
          <div class="empty-message">Loading branches…</div>
        {:else if rows.length === 0 && !branchTreeStore.state.error}
          <div class="empty-message">No branches found.</div>
        {:else}
          {#each rows as row (row.kind === 'segment' ? `segment:${row.id}` : row.id)}
            {#if row.kind === 'segment'}
              <button
                type="button"
                class="tree-row segment-row"
                data-segment-id={row.id}
                style={`--depth: ${Math.min(row.depth, 6)}`}
                onclick={() => toggleSegment(row.id)}
                title="Expand messages"
              >
                <span class="segment-chip">[…] {row.hiddenCount} messages</span>
                <ChevronRight size={14} />
              </button>
            {:else}
              <div
                class:active-path={row.isActive}
                class:selected={selectedId === row.id}
                class:match={matchingIds.has(row.id)}
                class="tree-row message-row"
                data-entry-id={row.id}
                style={`--depth: ${Math.min(row.depth, 6)}`}
                role="button"
                tabindex="0"
                onclick={() => selectMessage(row.id)}
                onkeydown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectMessage(row.id);
                  }
                }}
              >
                <span class="role-icon" aria-hidden="true">{row.role === 'user' ? '👤' : '🤖'}</span>
                <div class="message-content">
                  <div class="message-heading">
                    <span class="preview" class:preview-expanded={expandedMessageIds.has(row.id)}>{row.text}</span>
                    {#if row.text.length > PREVIEW_CLAMP_THRESHOLD}
                      <button
                        type="button"
                        class="preview-toggle"
                        title={expandedMessageIds.has(row.id) ? 'Collapse message preview' : 'Expand message preview'}
                        aria-label={expandedMessageIds.has(row.id) ? 'Collapse message preview' : 'Expand message preview'}
                        aria-expanded={expandedMessageIds.has(row.id)}
                        onclick={(event) => {
                          event.stopPropagation();
                          toggleMessagePreview(row.id);
                        }}
                        onkeydown={(event) => event.stopPropagation()}
                      >
                        {#if expandedMessageIds.has(row.id)}
                          <ChevronDown size={13} aria-hidden="true" />
                        {:else}
                          <ChevronRight size={13} aria-hidden="true" />
                        {/if}
                      </button>
                    {/if}
                    {#if row.label && editingLabelId !== row.id}
                      <button
                        type="button"
                        class="label-chip"
                        title="Edit label"
                        onclick={(event) => {
                          event.stopPropagation();
                          beginNodeLabelEdit(row);
                        }}
                      >
                        <Tag size={11} />
                        {row.label}
                      </button>
                    {/if}
                    {#if editingLabelId === row.id}
                      <input
                        bind:this={labelInputEl}
                        class="inline-label"
                        aria-label="Branch label"
                        value={editingLabelValue}
                        oninput={(event) => (editingLabelValue = (event.currentTarget as HTMLInputElement).value)}
                        onkeydown={(event) => handleLabelKeydown(event, row.id)}
                        onblur={() => void commitLabel(row.id)}
                        onclick={(event) => event.stopPropagation()}
                      />
                    {:else}
                      <button
                        type="button"
                        class="label-add"
                        title="Add label"
                        aria-label="Add label"
                        onclick={(event) => {
                          event.stopPropagation();
                          beginNodeLabelEdit(row);
                        }}
                      >
                        <Plus size={13} />
                      </button>
                    {/if}
                    {#if row.isActive}<span class="active-chip">active</span>{/if}
                  </div>
                </div>
              </div>
              {#if isExpandedSegmentBefore(row)}
                {@const segment = isExpandedSegmentBefore(row)!}
                <button
                  type="button"
                  class="tree-row segment-row collapse-row"
                  data-segment-id={segment}
                  style={`--depth: ${Math.min(row.depth, 6)}`}
                  onclick={() => toggleSegment(segment)}
                  title="Collapse messages"
                >
                  <span class="segment-chip">⊟ collapse</span>
                  <ChevronDown size={14} />
                </button>
              {/if}
            {/if}
          {/each}
        {/if}
      </div>

      <footer class="explorer-footer">
        {#if canResume}
          <button type="button" class="secondary-button" onclick={openCompaction}>Custom compaction…</button>
        {/if}
        <button type="button" class="primary-button" disabled={!canResume || branchTreeStore.state.busy} onclick={() => void resume()}>Resume from here</button>
        {#if branchTreeStore.state.busy}<span class="busy-message" role="status">Navigating…</span>{/if}
      </footer>
    </div>
  </div>
{/if}

<Dialog.Root open={compactionOpen} onOpenChange={(open) => !open && cancelCompaction()}>
  <Dialog.Content showCloseButton={false} class="compaction-dialog">
    <Dialog.Header>
      <Dialog.Title>Resume with compaction</Dialog.Title>
      <Dialog.Description>Optionally tell pi how to summarize the conversation first.</Dialog.Description>
    </Dialog.Header>
    <textarea bind:value={compactionPrompt} aria-label="Compaction prompt" placeholder="Compaction prompt…"></textarea>
    <Dialog.Footer>
      <Button variant="outline" type="button" onclick={cancelCompaction}>Cancel</Button>
      <Button type="button" onclick={() => void submitCompaction()}>OK</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .explorer-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--foreground) 60%, transparent);
  }

  .explorer-frame {
    display: flex;
    width: min(96vw, 1080px);
    height: min(92dvh, 960px);
    max-width: 100%;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--background);
    box-shadow: 0 20px 50px color-mix(in srgb, var(--foreground) 30%, transparent);
  }

  .explorer-header,
  .explorer-footer {
    flex-shrink: 0;
    border-color: var(--border);
    background: color-mix(in srgb, var(--background) 94%, transparent);
    padding: 0.75rem 1rem;
  }

  .explorer-header {
    border-bottom: 1px solid var(--border);
  }
  .explorer-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .explorer-title-row,
  .search-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .search-row {
    margin-top: 0.65rem;
    justify-content: initial;
  }
  .search-row input {
    min-width: 0;
    flex: 1;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--secondary);
    color: var(--foreground);
    padding: 0.45rem 0.65rem;
    font-size: 0.875rem;
  }
  .text-button {
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.8rem;
  }
  .text-button:hover {
    color: var(--foreground);
  }
  .scope-chip,
  .segment-chip,
  .active-chip,
  .label-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    border-radius: 999px;
    padding: 0.15rem 0.45rem;
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .scope-chip {
    background: var(--secondary);
    color: var(--muted-foreground);
  }
  .search-notice {
    margin-top: 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }
  .small-button {
    margin-left: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    background: var(--secondary);
    color: var(--foreground);
    padding: 0.2rem 0.4rem;
    cursor: pointer;
    font-size: 0.72rem;
  }
  .explorer-tree {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 0.5rem;
  }
  .tree-row {
    margin-inline-start: min(calc(var(--depth) * 1.1rem), 35vw);
    max-width: calc(100% - min(calc(var(--depth) * 1.1rem), 35vw));
  }
  .message-row {
    display: flex;
    align-items: flex-start;
    width: calc(100% - 0.25rem);
    gap: 0.45rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    padding: 0.45rem 0.5rem;
    color: var(--foreground);
    cursor: pointer;
    text-align: left;
  }
  .message-row:hover {
    background: var(--accent);
  }
  .message-row.selected {
    border-color: var(--ring);
    background: var(--accent);
    box-shadow: 0 0 0 1px var(--ring);
  }
  .message-row.active-path {
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
  }
  .message-row.match .preview {
    background: color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .role-icon {
    flex: 0 0 auto;
    font-size: 0.85rem;
  }
  .message-content {
    min-width: 0;
    flex: 1;
  }
  .message-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .preview {
    display: -webkit-box;
    flex: 1 1 auto;
    min-width: 0;
    max-height: calc(2 * 1.35em);
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .preview.preview-expanded {
    display: block;
    max-height: min(50dvh, 20rem);
    overflow-y: auto;
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .preview-toggle {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--muted-foreground);
    padding: 0;
    cursor: pointer;
  }
  .preview-toggle:hover {
    background: var(--secondary);
    color: var(--foreground);
  }
  .active-chip {
    background: color-mix(in srgb, var(--primary) 18%, transparent);
    color: var(--primary);
  }
  .label-chip {
    border: 0;
    background: var(--secondary);
    color: var(--secondary-foreground);
    cursor: pointer;
  }
  .label-add {
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    opacity: 0;
  }
  .message-row:hover .label-add,
  .message-row.selected .label-add {
    opacity: 1;
  }
  .inline-label {
    min-width: 8rem;
    max-width: 100%;
    border: 1px solid var(--ring);
    border-radius: 0.3rem;
    background: var(--background);
    color: var(--foreground);
    padding: 0.15rem 0.3rem;
    font-size: 0.72rem;
  }
  .segment-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: calc(100% - 0.25rem);
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--muted-foreground);
    padding: 0.3rem 0.5rem;
    cursor: pointer;
    text-align: left;
  }
  .segment-row:hover {
    background: var(--accent);
    color: var(--foreground);
  }
  .collapse-row {
    justify-content: initial;
    gap: 0.4rem;
  }
  .error-message {
    margin: 0.5rem;
    border: 1px solid var(--destructive);
    border-radius: 0.4rem;
    color: var(--destructive);
    padding: 0.55rem 0.7rem;
    font-size: 0.8rem;
  }
  .empty-message {
    color: var(--muted-foreground);
    padding: 1.25rem 0.75rem;
    font-size: 0.8rem;
  }
  .secondary-button,
  .primary-button {
    border-radius: 0.4rem;
    padding: 0.45rem 0.7rem;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .secondary-button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--foreground);
  }
  .primary-button {
    border: 1px solid var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 600;
  }
  .secondary-button:disabled,
  .primary-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .busy-message {
    color: var(--muted-foreground);
    font-size: 0.72rem;
  }
  :global(.compaction-dialog textarea) {
    width: 100%;
    min-height: 6rem;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--background);
    color: var(--foreground);
    padding: 0.5rem;
    font: inherit;
  }

  @media (max-width: 640px) {
    .explorer-overlay {
      align-items: stretch;
      padding: 0;
    }
    .explorer-frame {
      width: 100%;
      height: 100dvh;
      border-radius: 0;
    }
    .explorer-header,
    .explorer-footer {
      padding-inline: 0.75rem;
    }
    .tree-row {
      margin-inline-start: min(calc(var(--depth) * 0.75rem), 24vw);
      max-width: calc(100% - min(calc(var(--depth) * 0.75rem), 24vw));
    }
    .label-add {
      opacity: 1;
    }
  }
</style>
