<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BranchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CopyButton from './CopyButton.svelte';
  import TtsButton from './TtsButton.svelte';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import ListTree from '@lucide/svelte/icons/list-tree';

  export interface MessageActionMenuProps {
    entryId: string;
    sessionId: string;
    abandonedBranchCount: number;
    manager?: boolean;
    readOnly?: boolean;
    store?: Pick<BranchTreeStore, 'navigate' | 'openFocused'>;
    onRedo?: (entryId: string, opts?: { compactionPrompt?: string }) => void | Promise<void>;
    onClose?: () => void;
    copyText?: string;
    ttsText?: string;
    messageKey?: string;
    children?: Snippet;
  }

  let {
    entryId,
    sessionId,
    abandonedBranchCount,
    manager = false,
    readOnly = false,
    store,
    onRedo,
    onClose,
    copyText,
    ttsText,
    messageKey = '',
    children,
  }: MessageActionMenuProps = $props();

  let compactionOpen = $state(false);
  let compactionPrompt = $state('');

  let navigationAllowed = $derived(!manager && !readOnly);

  function redo(opts?: { compactionPrompt?: string }) {
    if (onRedo) {
      void (opts === undefined ? onRedo(entryId) : onRedo(entryId, opts));
      onClose?.();
      return;
    }
    if (store) void (opts === undefined ? store.navigate(entryId) : store.navigate(entryId, opts));
    onClose?.();
  }

  function openCompaction() {
    compactionPrompt = '';
    compactionOpen = true;
  }

  function cancelCompaction() {
    compactionOpen = false;
    compactionPrompt = '';
  }

  function submitCompaction() {
    const prompt = compactionPrompt;
    compactionOpen = false;
    compactionPrompt = '';
    redo({ compactionPrompt: prompt });
  }

  function openBranches() {
    if (store) void store.openFocused(sessionId, entryId);
    onClose?.();
  }
</script>

<div class="message-action-menu tool-menu" role="menu">
  {#if navigationAllowed}
    <button type="button" role="menuitem" class="action-item" title="Redo from here" onclick={() => redo()}>
      <Undo2 size={14} />
      <span>Redo from here</span>
    </button>
    <button type="button" role="menuitem" class="action-item" title="Redo with compaction" onclick={openCompaction}>
      <GitBranch size={14} />
      <span>Redo with compaction…</span>
    </button>
    {#if abandonedBranchCount > 0}
      <button type="button" role="menuitem" class="action-item" title="View existing branches" onclick={openBranches}>
        <ListTree size={14} />
        <span>View existing branches ({abandonedBranchCount})</span>
      </button>
    {/if}
  {/if}
  {#if ttsText !== undefined && messageKey}
    <TtsButton {messageKey} textContent={ttsText} />
  {/if}
  {#if copyText !== undefined}
    <CopyButton text={copyText} title="Copy message" />
  {/if}
  {@render children?.()}
</div>

<Dialog.Root open={compactionOpen} onOpenChange={(open) => !open && cancelCompaction()}>
  <Dialog.Content showCloseButton={false} preventScroll={false} class="compaction-dialog">
    <Dialog.Header>
      <Dialog.Title>Redo with compaction</Dialog.Title>
      <Dialog.Description>Optionally tell pi how to summarize the conversation before redoing this message.</Dialog.Description>
    </Dialog.Header>
    <textarea bind:value={compactionPrompt} placeholder="Compaction prompt…" aria-label="Compaction prompt"></textarea>
    <Dialog.Footer>
      <Button variant="outline" onclick={cancelCompaction}>Cancel</Button>
      <Button onclick={submitCompaction}>OK</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .message-action-menu {
    align-items: stretch;
    min-width: 12rem;
  }

  .action-item {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 28px;
    border: 0;
    border-radius: 0.35rem;
    padding: 0.25rem 0.5rem;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    font-size: 0.8rem;
    text-align: left;
    white-space: nowrap;
  }

  .action-item:hover,
  .action-item:focus-visible {
    background: var(--secondary);
    outline: none;
  }

  textarea {
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
</style>
