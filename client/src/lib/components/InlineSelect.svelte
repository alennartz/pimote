<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { getExtensionUiQueue, INLINE_METHODS } from '$lib/stores/extension-ui-queue.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';

  interface ParsedOption {
    value: string;
    label: string;
    description?: string;
  }

  function parseOption(raw: string): ParsedOption {
    let text = raw.replace(/^\d\.\s+/, '');
    const dashMatch = text.match(/^(.+?)\s+[—–]\s+(.+)$/s);
    if (dashMatch) {
      return { value: raw, label: dashMatch[1]!.trim(), description: dashMatch[2]!.trim() };
    }
    return { value: raw, label: text.trim() };
  }

  const uiQueue = getExtensionUiQueue();
  let highlightIndex = $state(-1);
  let collapsed = $state(false);
  let panelEl: HTMLDivElement | undefined = $state();

  // Filter to only show dialogs for the currently viewed session
  let current = $derived.by(() => {
    const viewedId = sessionRegistry.viewedSessionId;
    return uiQueue.all.find((r) => INLINE_METHODS.has(r.method) && r.sessionId === viewedId) ?? null;
  });

  // Reset highlight + expand when a new request appears
  $effect(() => {
    if (current) {
      highlightIndex = -1;
      collapsed = false;
    }
  });

  // Move focus to the first answer when a question appears in every viewport.
  $effect(() => {
    const request = current;
    const panel = panelEl;
    if (!request || !panel) return;
    const active = document.activeElement;

    void tick().then(() => {
      if (panelEl !== panel || current?.sessionId !== request.sessionId || current?.requestId !== request.requestId) return;
      if (document.activeElement !== active && document.activeElement !== document.body) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]')) return;
      (panel.querySelector<HTMLButtonElement>('[data-inline-answer]') ?? panel).focus();
    });
  });

  let displayedRequest: { sessionId: string; requestId: string } | null = null;
  let answeredRequest: { sessionId: string; requestId: string } | null = null;

  $effect.pre(() => {
    const next = current;
    const previous = displayedRequest;
    if (previous && (next?.sessionId !== previous.sessionId || next?.requestId !== previous.requestId)) {
      const answeredHere = answeredRequest?.sessionId === previous.sessionId && answeredRequest.requestId === previous.requestId;
      if (answeredHere) answeredRequest = null;
      if (!next && sessionRegistry.viewedSessionId === previous.sessionId && !untrack(isMobileViewport) && (answeredHere || panelEl?.contains(document.activeElement))) {
        void restoreComposerFocus(previous.sessionId, document.activeElement);
      }
    }
    displayedRequest = next ? { sessionId: next.sessionId, requestId: next.requestId } : null;
  });

  async function restoreComposerFocus(sessionId: string, previousFocus: Element | null): Promise<void> {
    await tick();
    if (sessionRegistry.viewedSessionId !== sessionId || uiQueue.all.some((request) => request.sessionId === sessionId) || untrack(isMobileViewport)) return;
    if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]')) return;
    const composer = document.getElementById('session-composer');
    if (composer instanceof HTMLTextAreaElement && !composer.disabled) composer.focus();
  }

  function toggleCollapsed(event: MouseEvent) {
    event.stopPropagation();
    collapsed = !collapsed;
  }

  function sendResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    if (!current) return;
    answeredRequest = { sessionId: current.sessionId, requestId: current.requestId };
    uiQueue.sendResponse(current.requestId, current.sessionId, data);
  }

  function handleSelect(value: string) {
    sendResponse({ value });
  }

  function handleConfirm(confirmed: boolean) {
    sendResponse({ confirmed });
  }

  function handleCancel() {
    sendResponse({ cancelled: true });
  }

  function handleKeydown(event: KeyboardEvent, normalizedOptions: { value: string; parsed: ParsedOption }[]) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;

    if (current?.method === 'select') {
      if (event.key >= '1' && event.key <= '9') {
        const idx = parseInt(event.key) - 1;
        if (idx < normalizedOptions.length) {
          event.preventDefault();
          handleSelect(normalizedOptions[idx]!.value);
          return;
        }
      }

      const optionButtons = panelEl ? [...panelEl.querySelectorAll<HTMLButtonElement>('.select-option')] : [];
      const focusedIndex = optionButtons.findIndex((button) => button === event.target);
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && normalizedOptions.length > 0) {
        event.preventDefault();
        const index = focusedIndex >= 0 ? focusedIndex : highlightIndex;
        highlightIndex = event.key === 'ArrowDown' ? Math.min(index + 1, normalizedOptions.length - 1) : Math.max(index - 1, 0);
        optionButtons[highlightIndex]?.focus();
        return;
      }

      if (event.key === 'Enter' && event.target === panelEl && highlightIndex >= 0 && highlightIndex < normalizedOptions.length) {
        event.preventDefault();
        handleSelect(normalizedOptions[highlightIndex]!.value);
        return;
      }
    }

    if (current?.method === 'confirm') {
      if (event.key === 'y' || event.key === 'Y') {
        event.preventDefault();
        handleConfirm(true);
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        handleConfirm(false);
        return;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
    }
  }
</script>

{#if current}
  {#if current.method === 'select'}
    {@const rawOptions = current.options ?? []}
    {@const normalizedOptions = rawOptions.map((o) => {
      const str = typeof o === 'string' ? o : (o.label ?? o.value ?? String(o));
      const value = typeof o === 'string' ? o : (o.value ?? o.label ?? String(o));
      return { value, parsed: parseOption(str) };
    })}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="inline-select-panel"
      class:collapsed
      tabindex="0"
      role="group"
      aria-label={current.title ?? 'Select'}
      bind:this={panelEl}
      onkeydown={(e) => handleKeydown(e, normalizedOptions)}
    >
      <div class="panel-header">
        <span class="panel-title">
          {current.title ?? 'Select'}
          {#if collapsed}<span class="panel-title-meta">· {normalizedOptions.length} option{normalizedOptions.length === 1 ? '' : 's'}</span>{/if}
        </span>
        <div class="panel-header-actions">
          <button class="panel-collapse" aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed} onclick={toggleCollapsed}>
            {collapsed ? '▾' : '▴'}
          </button>
          <button class="panel-cancel" onclick={handleCancel}>Esc to cancel</button>
        </div>
      </div>
      {#if !collapsed}
        {#if current.message}
          <div class="panel-description">{current.message}</div>
        {/if}
        <div class="panel-options">
          {#each normalizedOptions as option, i (option.value)}
            {@const p = option.parsed}
            <button
              class="select-option"
              data-inline-answer
              class:highlighted={i === highlightIndex}
              onclick={() => handleSelect(option.value)}
              onmouseenter={() => (highlightIndex = i)}
              onfocus={() => (highlightIndex = i)}
            >
              <span class="option-number">{i + 1}</span>
              <span class="option-body">
                <span class="option-label">{p.label}</span>
                {#if p.description}
                  <span class="option-desc">{p.description}</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
        <div class="panel-hint">
          <span><kbd>1</kbd>–<kbd>{normalizedOptions.length}</kbd> select</span>
          <span class="hint-sep">·</span>
          <span><kbd>↑↓</kbd> navigate</span>
          <span class="hint-sep">·</span>
          <span><kbd>Enter</kbd> confirm</span>
          <span class="hint-sep">·</span>
          <span><kbd>Esc</kbd> cancel</span>
        </div>
      {/if}
    </div>
  {:else if current.method === 'confirm'}
    <div class="inline-select-panel" class:collapsed tabindex="0" role="dialog" aria-label={current.title ?? 'Confirm'} bind:this={panelEl} onkeydown={(e) => handleKeydown(e, [])}>
      <div class="panel-header">
        <span class="panel-title">{current.title ?? 'Confirm'}</span>
        <div class="panel-header-actions">
          <button class="panel-collapse" aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed} onclick={toggleCollapsed}>
            {collapsed ? '▾' : '▴'}
          </button>
          <button class="panel-cancel" onclick={handleCancel}>Esc to cancel</button>
        </div>
      </div>
      {#if !collapsed}
        {#if current.message}
          <div class="panel-description">{current.message}</div>
        {/if}
        <div class="confirm-actions">
          <Button variant="outline" data-inline-answer onclick={() => handleConfirm(false)}>No</Button>
          <Button data-inline-answer onclick={() => handleConfirm(true)}>Yes</Button>
        </div>
        <div class="panel-hint">
          <span><kbd>Y</kbd> yes</span>
          <span class="hint-sep">·</span>
          <span><kbd>N</kbd> no</span>
          <span class="hint-sep">·</span>
          <span><kbd>Esc</kbd> cancel</span>
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .inline-select-panel {
    border-top: 1px solid var(--border);
    background: var(--background);
    padding: 12px 16px;
    outline: none;
  }

  .inline-select-panel:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  /* Every row shares one centered column, so the question and options align. */
  .inline-select-panel > * {
    max-width: 768px;
    margin-left: auto;
    margin-right: auto;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .panel-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--foreground);
  }

  .panel-cancel {
    font-size: 0.7rem;
    color: var(--muted-foreground);
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0.7;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .panel-cancel:hover {
    opacity: 1;
    background: var(--accent);
  }

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .panel-collapse {
    font-size: 1.25rem;
    line-height: 1;
    color: var(--muted-foreground);
    background: none;
    border: 1px solid var(--border);
    cursor: pointer;
    opacity: 0.9;
    min-width: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    border-radius: 6px;
  }

  .panel-collapse:hover {
    opacity: 1;
    background: var(--accent);
  }

  .panel-title-meta {
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    margin-left: 4px;
  }

  .inline-select-panel.collapsed .panel-header {
    margin-bottom: 0;
  }

  .panel-description {
    font-size: 0.8rem;
    color: var(--muted-foreground);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .panel-options {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .select-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: none;
    text-align: left;
    font-size: 0.875rem;
    cursor: pointer;
    transition:
      background-color 0.1s,
      border-color 0.1s;
    color: var(--foreground);
  }

  .select-option:hover,
  .select-option.highlighted {
    background: var(--accent);
    border-color: var(--border);
  }

  .option-number {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--secondary);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .select-option:hover .option-number,
  .select-option.highlighted .option-number {
    background: var(--chart-3);
    color: var(--primary-foreground);
  }

  .option-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding-top: 1px;
  }

  .option-label {
    font-weight: 500;
    line-height: 1.35;
  }

  .option-desc {
    font-size: 0.8rem;
    color: var(--muted-foreground);
    line-height: 1.4;
  }

  .confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 4px 0;
  }

  .panel-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 8px;
    font-size: 0.7rem;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .panel-hint kbd {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--secondary);
    font-family: inherit;
    font-size: 0.65rem;
  }

  .hint-sep {
    opacity: 0.5;
  }
</style>
