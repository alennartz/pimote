<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
		DropdownMenuLabel,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import BrainCog from '@lucide/svelte/icons/brain-cog';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	const levels = ['off', 'minimal', 'low', 'medium', 'high'] as const;

	let selectedLevel = $state(sessionRegistry.viewed?.thinkingLevel ?? 'off');
	let mounted = $state(false);

	// Keep local selection in sync with store
	$effect(() => {
		selectedLevel = sessionRegistry.viewed?.thinkingLevel ?? 'off';
	});

	// Send command when local selection changes from store value (skip on mount)
	$effect(() => {
		const viewedLevel = sessionRegistry.viewed?.thinkingLevel ?? 'off';
		if (mounted && selectedLevel !== viewedLevel && sessionRegistry.viewed?.sessionId) {
			const sid = sessionRegistry.viewed.sessionId;
			const level = selectedLevel;
			connection.send({
				type: 'set_thinking_level',
				sessionId: sid,
				level,
			}).then((res) => {
				if (res.success) {
					const session = sessionRegistry.sessions[sid];
					if (session) session.thinkingLevel = level;
				}
			});
		}
	});

	// Mark as mounted after first effects have run
	$effect(() => {
		mounted = true;
	});

	function labelFor(level: string): string {
		return level.charAt(0).toUpperCase() + level.slice(1);
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger>
		{#snippet children()}
			<Button
				variant="ghost"
				size="xs"
				class="gap-1 text-muted-foreground"
				title="Thinking level: {sessionRegistry.viewed?.thinkingLevel ?? 'off'}"
			>
				<BrainCog class="size-3" />
				<span class="text-xs">{labelFor(sessionRegistry.viewed?.thinkingLevel ?? 'off')}</span>
			</Button>
		{/snippet}
	</DropdownMenuTrigger>
	<DropdownMenuContent align="start" class="min-w-36">
		<DropdownMenuLabel>Thinking Level</DropdownMenuLabel>
		<DropdownMenuSeparator />
		<DropdownMenuRadioGroup bind:value={selectedLevel}>
			{#each levels as level}
				<DropdownMenuRadioItem value={level}>
					{labelFor(level)}
				</DropdownMenuRadioItem>
			{/each}
		</DropdownMenuRadioGroup>
	</DropdownMenuContent>
</DropdownMenu>
