<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BranchTreeStore } from '$lib/stores/branch-tree-store.svelte.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CopyButton from './CopyButton.svelte';
  import TtsButton from './TtsButton.svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import GitFork from '@lucide/svelte/icons/git-fork';
  import GitBranch from '@lucide/svelte/icons/git-branch';

  export interface MessageActionMenuProps {
    entryId: string;
    sessionId: string;
    abandonedBranchCount: number;
    open?: boolean;
    manager?: boolean;
    readOnly?: boolean;
    store?: Pick<BranchTreeStore, 'navigate' | 'openFocused'>;
    onRedo?: (entryId: string, opts?: { compactionPrompt?: string }) => void | Promise<void>;
    onFork?: (entryId: string) => void | Promise<void>;
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
    open = true,
    manager = false,
    readOnly = false,
    store,
    onRedo,
    onFork,
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
    onClose?.();
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

  function forkFromHere() {
    if (onFork) void onFork(entryId);
    onClose?.();
  }
</script>

{#if open}
  <div class="message-action-menu tool-menu" role="menu">
    {#if navigationAllowed}
      <button type="button" role="menuitem" class="action-item" title="Redo from here" aria-label="Redo from here" onclick={() => redo()}>
        <RotateCcw size={14} aria-hidden="true" />
      </button>
      <button type="button" role="menuitem" class="action-item" title="Rewind with compaction" aria-label="Rewind with compaction" onclick={openCompaction}>
        <span class="composite-icon" aria-hidden="true">
          <RotateCcw size={14} />
          <svg class="compaction-overlay" viewBox="0 0 8 8" width="8" height="8">
            <rect x="0.5" y="0.5" width="7" height="7" rx="1.5" fill="var(--secondary)" stroke="var(--background)" />
            <path d="M2 3h4M2 5h4" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          </svg>
        </span>
      </button>
      {#if onFork}
        <button type="button" role="menuitem" class="action-item" title="Fork from this message" aria-label="Fork from this message" onclick={forkFromHere}>
          <GitFork size={14} aria-hidden="true" />
        </button>
      {/if}
      {#if abandonedBranchCount > 0}
        <button
          type="button"
          role="menuitem"
          class="action-item branch-action"
          title="View existing branches"
          aria-label={`View existing branches (${abandonedBranchCount})`}
          onclick={openBranches}
        >
          <GitBranch size={14} aria-hidden="true" />
          <span class="branch-count" aria-hidden="true">{abandonedBranchCount}</span>
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
{/if}

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
    /* Own its layout: the parent's .tool-menu scoped rules never reach this
       component's root (Svelte scoping). Desktop stacks vertically; mobile
       flows as one horizontal row. */
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  @media (max-width: 640px) {
    .message-action-menu {
      flex-direction: row;
    }
  }

  .action-item {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0.35rem;
    padding: 0.25rem;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
  }

  .branch-action {
    width: auto;
    min-width: 36px;
    gap: 0.2rem;
  }

  .composite-icon {
    position: relative;
    display: inline-flex;
    width: 14px;
    height: 14px;
  }

  .composite-icon :global(svg:first-child) {
    display: block;
  }

  .compaction-overlay {
    position: absolute;
    right: -2px;
    bottom: -2px;
    color: var(--foreground);
  }

  .branch-count {
    min-width: 1rem;
    border-radius: 999px;
    padding: 0 0.2rem;
    background: var(--secondary);
    color: var(--foreground);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
    line-height: 1.1rem;
    text-align: center;
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
