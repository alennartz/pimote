<script lang="ts">
	import ModelPicker from './ModelPicker.svelte';
	import ThinkingPicker from './ThinkingPicker.svelte';
	import CompactButton from './CompactButton.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	let connectionLabel = $derived(
		connection.status === 'connected'
			? 'Connected'
			: connection.status === 'reconnecting'
				? 'Reconnecting…'
				: connection.status === 'connecting'
					? 'Connecting…'
					: 'Disconnected'
	);

	let connectionColor = $derived(
		connection.status === 'connected'
			? 'bg-emerald-500'
			: connection.status === 'reconnecting'
				? 'bg-amber-500'
				: 'bg-red-500'
	);
</script>

<div
	class="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 text-xs text-muted-foreground"
>
	<!-- Model picker -->
	<ModelPicker />

	<Separator orientation="vertical" class="mx-0.5 h-4" />

	<!-- Thinking level picker -->
	<ThinkingPicker />

	<Separator orientation="vertical" class="mx-0.5 h-4" />

	<!-- Compact button -->
	<CompactButton />

	<!-- Spacer -->
	<div class="flex-1"></div>

	<!-- Streaming indicator -->
	{#if sessionStore.isStreaming}
		<Badge variant="secondary" class="gap-1.5 text-xs">
			<span class="relative flex size-2">
				<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
				<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
			</span>
			Streaming
		</Badge>
	{/if}

	<!-- Compacting indicator -->
	{#if sessionStore.isCompacting}
		<Badge variant="secondary" class="gap-1 text-xs">
			<span class="relative flex size-2">
				<span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
				<span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
			</span>
			Compacting…
		</Badge>
	{/if}

	<!-- Connection status -->
	<div class="flex items-center gap-1.5" title={connectionLabel}>
		<span class="relative flex size-2">
			<span class="relative inline-flex size-2 rounded-full {connectionColor}"></span>
		</span>
		<span class="hidden text-xs sm:inline">{connectionLabel}</span>
	</div>
</div>
