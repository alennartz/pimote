<script lang="ts">
	import { onMount } from 'svelte';
	import { connection } from '$lib/stores/connection.svelte.js';
	import type { ExtensionUiRequestEvent } from '@pimote/shared';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	// Fire-and-forget methods handled by ExtensionStatus
	const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify', 'setEditorText']);

	interface DialogRequest {
		requestId: string;
		sessionId: string;
		method: string;
		title?: string;
		message?: string;
		options?: { label: string; value: string }[];
		placeholder?: string;
		content?: string;
		[key: string]: unknown;
	}

	// Parsed option with optional structured parts
	interface ParsedOption {
		value: string;       // original string — sent back as the response
		label: string;       // main label text
		description?: string; // description after " — " separator
	}

	/**
	 * Parse a select option string. We always render our own number badges,
	 * so if the string has a leading "N. " prefix we strip it.
	 * Then if there's an em-dash/en-dash separator we split label/description.
	 * Otherwise the whole (stripped) string is the label.
	 */
	function parseOption(raw: string): ParsedOption {
		// Strip leading "N. " prefix if present (we render our own numbers)
		let text = raw.replace(/^\d\.\s+/, '');

		// Try em-dash or en-dash separator for description
		const dashMatch = text.match(/^(.+?)\s+[—–]\s+(.+)$/s);
		if (dashMatch) {
			return { value: raw, label: dashMatch[1]!.trim(), description: dashMatch[2]!.trim() };
		}

		return { value: raw, label: text.trim() };
	}

	let queue: DialogRequest[] = $state([]);
	let current: DialogRequest | null = $derived(queue[0] ?? null);
	let dialogOpen = $state(false);
	let highlightIndex = $state(-1);

	// Input state for input/editor methods
	let inputValue = $state('');

	// Keep dialog open when there's a current request
	$effect(() => {
		if (current) {
			highlightIndex = -1;
			// Reset input value when showing a new dialog
			if (current.method === 'input') {
				inputValue = (current.placeholder as string) ?? '';
			} else if (current.method === 'editor') {
				inputValue = (current.content as string) ?? '';
			}
			dialogOpen = true;
		} else {
			dialogOpen = false;
		}
	});

	function sendResponse(data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
		if (!current) return;
		const { requestId, sessionId } = current;
		connection.send({
			type: 'extension_ui_response',
			sessionId,
			requestId,
			...data,
		});
		// Remove from queue
		queue = queue.slice(1);
	}

	function handleCancel() {
		sendResponse({ cancelled: true });
	}

	function handleOpenChange(open: boolean) {
		if (!open && current) {
			// Dialog dismissed (e.g. clicking overlay or pressing Escape)
			handleCancel();
		}
	}

	function handleSelect(value: string) {
		sendResponse({ value });
	}

	function handleConfirm(confirmed: boolean) {
		sendResponse({ confirmed });
	}

	function handleInputSubmit() {
		sendResponse({ value: inputValue });
	}

	function handleEditorSubmit() {
		sendResponse({ value: inputValue });
	}

	function handleSelectKeydown(event: KeyboardEvent, normalizedOptions: { value: string; parsed: ParsedOption }[]) {
		// Digit keys 1-9: select option by position
		if (event.key >= '1' && event.key <= '9') {
			const idx = parseInt(event.key) - 1;
			if (idx < normalizedOptions.length) {
				event.preventDefault();
				handleSelect(normalizedOptions[idx]!.value);
				return;
			}
		}

		// Arrow keys for highlight navigation
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (event.key === 'ArrowDown') {
				highlightIndex = Math.min(highlightIndex + 1, normalizedOptions.length - 1);
			} else {
				highlightIndex = Math.max(highlightIndex - 1, 0);
			}
			return;
		}

		// Enter selects highlighted option
		if (event.key === 'Enter' && highlightIndex >= 0 && highlightIndex < normalizedOptions.length) {
			event.preventDefault();
			handleSelect(normalizedOptions[highlightIndex]!.value);
		}
	}

	onMount(() => {
		const unsubscribe = connection.onEvent((event) => {
			if (event.type !== 'extension_ui_request') return;
			const req = event as ExtensionUiRequestEvent;
			if (FIRE_AND_FORGET.has(req.method)) return;
			queue = [...queue, req as unknown as DialogRequest];
		});
		return unsubscribe;
	});
</script>

<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
	{#if current}
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>{current.title ?? 'Extension'}</Dialog.Title>
				{#if current.message}
					<Dialog.Description>{current.message}</Dialog.Description>
				{/if}
			</Dialog.Header>

			{#if current.method === 'select'}
				{@const rawOptions = current.options ?? []}
				{@const normalizedOptions = rawOptions.map((o: any) => {
					const str = typeof o === 'string' ? o : (o.label ?? o.value ?? String(o));
					const value = typeof o === 'string' ? o : (o.value ?? o.label ?? String(o));
					return { value, parsed: parseOption(str) };
				})}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="select-options"
					tabindex="0"
					onkeydown={(e) => handleSelectKeydown(e, normalizedOptions)}
				>
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
				<div class="select-hint">
					<span><kbd>1</kbd>–<kbd>{normalizedOptions.length}</kbd> select</span>
					<span class="hint-sep">·</span>
					<span><kbd>↑↓</kbd> navigate</span>
					<span class="hint-sep">·</span>
					<span><kbd>Enter</kbd> confirm</span>
					<span class="hint-sep">·</span>
					<span><kbd>Esc</kbd> cancel</span>
				</div>
			{:else if current.method === 'confirm'}
				<Dialog.Footer>
					<Button variant="outline" onclick={() => handleConfirm(false)}>No</Button>
					<Button onclick={() => handleConfirm(true)}>Yes</Button>
				</Dialog.Footer>
			{:else if current.method === 'input'}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						handleInputSubmit();
					}}
					class="flex flex-col gap-4"
				>
					<Input
						bind:value={inputValue}
						placeholder={current.placeholder as string ?? ''}
						autofocus
					/>
					<Dialog.Footer>
						<Button variant="outline" type="button" onclick={handleCancel}>Cancel</Button>
						<Button type="submit">Submit</Button>
					</Dialog.Footer>
				</form>
			{:else if current.method === 'editor'}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						handleEditorSubmit();
					}}
					class="flex flex-col gap-4"
				>
					<textarea
						bind:value={inputValue}
						class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-[200px] w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-3"
					></textarea>
					<Dialog.Footer>
						<Button variant="outline" type="button" onclick={handleCancel}>Cancel</Button>
						<Button type="submit">Save</Button>
					</Dialog.Footer>
				</form>
			{/if}
		</Dialog.Content>
	{/if}
</Dialog.Root>

<style>
	.select-options {
		display: flex;
		flex-direction: column;
		gap: 2px;
		outline: none;
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

	.select-hint {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-top: 8px;
		font-size: 0.7rem;
		color: var(--muted-foreground);
		opacity: 0.7;
	}

	.select-hint kbd {
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
