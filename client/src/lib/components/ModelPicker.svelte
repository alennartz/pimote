<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuGroup,
		DropdownMenuGroupHeading,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
		DropdownMenuLabel,
	} from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	interface AvailableModel {
		provider: string;
		id: string;
		name: string;
	}

	let models: AvailableModel[] = $state([]);
	let loading = $state(false);
	let open = $state(false);

	// Group models by provider
	let grouped = $derived.by(() => {
		const map = new Map<string, AvailableModel[]>();
		for (const m of models) {
			const list = map.get(m.provider) ?? [];
			list.push(m);
			map.set(m.provider, list);
		}
		return map;
	});

	// Fetch models when dropdown opens
	$effect(() => {
		if (open) {
			fetchModels();
		}
	});

	async function fetchModels() {
		if (loading) return;
		loading = true;
		try {
			const res = await connection.send({ type: 'get_available_models' });
			if (res.success && res.data) {
				const arr = (res.data as any).models;
				if (Array.isArray(arr)) {
					models = arr as AvailableModel[];
				}
			}
		} catch {
			// ignore — models stay empty
		} finally {
			loading = false;
		}
	}

	async function selectModel(model: AvailableModel) {
		if (!sessionRegistry.viewed?.sessionId) return;
		await connection.send({
			type: 'set_model',
			sessionId: sessionRegistry.viewed.sessionId,
			provider: model.provider,
			modelId: model.id,
		});
		open = false;
	}

	function isSelected(model: AvailableModel): boolean {
		return (
			sessionRegistry.viewed?.model?.provider === model.provider &&
			sessionRegistry.viewed?.model?.id === model.id
		);
	}
</script>

<DropdownMenu bind:open>
	<DropdownMenuTrigger>
		{#snippet children()}
			<Button
				variant="ghost"
				size="xs"
				class="gap-1 text-muted-foreground max-w-48 truncate"
				title={sessionRegistry.viewed?.model
					? `${sessionRegistry.viewed.model.provider}/${sessionRegistry.viewed.model.name}`
					: 'No model selected'}
			>
				<span class="truncate text-xs">
					{sessionRegistry.viewed?.model?.name ?? 'No model'}
				</span>
				<ChevronDown class="size-3 shrink-0" />
			</Button>
		{/snippet}
	</DropdownMenuTrigger>
	<DropdownMenuContent align="start" class="max-h-72 min-w-52 overflow-y-auto">
		<DropdownMenuLabel>Models</DropdownMenuLabel>
		<DropdownMenuSeparator />
		{#if loading && models.length === 0}
			<div class="flex items-center justify-center py-4">
				<Loader2 class="size-4 animate-spin text-muted-foreground" />
			</div>
		{:else if models.length === 0}
			<div class="px-2 py-4 text-center text-xs text-muted-foreground">
				No models available
			</div>
		{:else}
			{#each [...grouped.entries()] as [provider, providerModels], i}
				{#if i > 0}
					<DropdownMenuSeparator />
				{/if}
				<DropdownMenuGroup>
					<DropdownMenuGroupHeading>{provider}</DropdownMenuGroupHeading>
					{#each providerModels as model}
						<DropdownMenuItem
							onclick={() => selectModel(model)}
							class="flex items-center justify-between gap-2"
						>
							<span class="truncate">{model.name}</span>
							{#if isSelected(model)}
								<Check class="size-3.5 shrink-0 text-primary" />
							{/if}
						</DropdownMenuItem>
					{/each}
				</DropdownMenuGroup>
			{/each}
		{/if}
	</DropdownMenuContent>
</DropdownMenu>
