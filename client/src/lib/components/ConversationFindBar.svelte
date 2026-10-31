<script lang="ts">
  import type { FindMatch } from '$lib/conversation-find.js';

  interface Props {
    matches: readonly FindMatch[];
    onMatch: (match: FindMatch) => void;
    onClose: () => void;
    query?: string;
  }

  let { matches, onMatch, onClose, query = $bindable('') }: Props = $props();
  let currentIndex = $state(-1);

  $effect(() => {
    // A new query produces a new match list. Start before the first result so
    // the first Next action selects the first match.
    matches.length;
    query;
    currentIndex = -1;
  });

  function move(direction: 1 | -1): void {
    if (matches.length === 0) return;
    currentIndex = (currentIndex + direction + matches.length) % matches.length;
    onMatch(matches[currentIndex]);
  }

  export function focusInput(): void {
    inputElement?.focus();
    inputElement?.select();
  }

  let inputElement: HTMLInputElement | undefined = $state();
</script>

<div class="findbar" role="search">
  <input bind:this={inputElement} bind:value={query} placeholder="Find in conversation" aria-label="Find in conversation" />
  <span class="count" aria-live="polite">{matches.length > 0 ? `${matches.length} matches` : query.trim() ? 'No matches' : ''}</span>
  <button type="button" aria-label="Previous match" onclick={() => move(-1)} disabled={matches.length === 0}>↑</button>
  <button type="button" aria-label="Next match" onclick={() => move(1)} disabled={matches.length === 0}>↓</button>
  <button type="button" aria-label="Close find" onclick={onClose}>✕</button>
</div>

<style>
  .findbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: min(100% - 1rem, 560px);
    margin: 0 auto 0.5rem;
    padding: 0.35rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--background);
    box-shadow: 0 2px 8px var(--shadow-color);
  }

  input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--foreground);
    font: inherit;
    font-size: 0.85rem;
  }

  .count {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  button {
    display: inline-flex;
    width: 1.7rem;
    height: 1.7rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0.3rem;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--secondary);
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }
</style>
