<script lang="ts">
	import { onMount } from 'svelte';
	import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';
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
	let panelEl: HTMLDivElement | undefined = $state();

	let current = $derived(uiQueue.inlineCurrent);

	// Reset highlight when a new request appears
	$effect(() => {
		if (current) {
			highlightIndex = -1;
		}
	});

	// Auto-focus the panel when it appears
	$effect(() => {
		if (current && panelEl) {
			panelEl.focus();
		}
	});

	function sendResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
		if (!current) return;
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
		if (current?.method === 'select') {
			if (event.key >= '1' && event.key <= '9') {
				const idx = parseInt(event.key) - 1;
				if (idx < normalizedOptions.length) {
					event.preventDefault();
					handleSelect(normalizedOptions[idx]!.value);
					return;
				}
			}

			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (event.key === 'ArrowDown') {
					highlightIndex = Math.min(highlightIndex + 1, normalizedOptions.length - 1);
				} else {
					highlightIndex = Math.max(highlightIndex - 1, 0);
				}
				return;
			}

			if (event.key === 'Enter' && highlightIndex >= 0 && highlightIndex < normalizedOptions.length) {
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
		<div
			class="inline-select-panel"
			tabindex="0"
			role="listbox"
			bind:this={panelEl}
			onkeydown={(e) => handleKeydown(e, normalizedOptions)}
		>
			<div class="panel-header">
				<span class="panel-title">{current.title ?? 'Select'}</span>
				<button class="panel-cancel" onclick={handleCancel}>Esc to cancel</button>
			</div>
			{#if current.message}
				<div class="panel-description">{current.message}</div>
			{/if}
			<div class="panel-options">
				{#each normalizedOptions as option, i}
					{@const p = option.parsed}
					<button
						class="select-option"
						class:highlighted={i === highlightIndex}
						onclick={() => handleSelect(option.value)}
						onmouseenter={() => highlightIndex = i}
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
		</div>
	{:else if current.method === 'confirm'}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="inline-select-panel"
			tabindex="0"
			role="dialog"
			bind:this={panelEl}
			onkeydown={(e) => handleKeydown(e, [])}
		>
			<div class="panel-header">
				<span class="panel-title">{current.title ?? 'Confirm'}</span>
				<button class="panel-cancel" onclick={handleCancel}>Esc to cancel</button>
			</div>
			{#if current.message}
				<div class="panel-description">{current.message}</div>
			{/if}
			<div class="confirm-actions">
				<Button variant="outline" onclick={() => handleConfirm(false)}>No</Button>
				<Button onclick={() => handleConfirm(true)}>Yes</Button>
			</div>
			<div class="panel-hint">
				<span><kbd>Y</kbd> yes</span>
				<span class="hint-sep">·</span>
				<span><kbd>N</kbd> no</span>
				<span class="hint-sep">·</span>
				<span><kbd>Esc</kbd> cancel</span>
			</div>
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
		max-width: 768px;
		margin: 0 auto;
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
		transition: background-color 0.1s, border-color 0.1s;
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
