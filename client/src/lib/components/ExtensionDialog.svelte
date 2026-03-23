<script lang="ts">
	import { onMount } from 'svelte';
	import { connection } from '$lib/stores/connection.svelte.js';
	import type { ExtensionUiRequestEvent } from '@pimote/shared';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	// Fire-and-forget methods handled by ExtensionStatus
	const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify']);

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

	let queue: DialogRequest[] = $state([]);
	let current: DialogRequest | null = $derived(queue[0] ?? null);
	let dialogOpen = $state(false);

	// Input state for input/editor methods
	let inputValue = $state('');

	// Keep dialog open when there's a current request
	$effect(() => {
		if (current) {
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
				<div class="flex flex-col gap-1">
					{#each current.options ?? [] as option}
						<button
							class="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
							onclick={() => handleSelect(option.value)}
						>
							{option.label}
						</button>
					{/each}
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
