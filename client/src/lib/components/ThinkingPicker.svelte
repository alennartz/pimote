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
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	const levels = ['off', 'minimal', 'low', 'medium', 'high'] as const;

	let selectedLevel = $state(sessionStore.thinkingLevel);

	// Keep local selection in sync with store
	$effect(() => {
		selectedLevel = sessionStore.thinkingLevel;
	});

	// Send command when local selection changes from store value
	$effect(() => {
		if (selectedLevel !== sessionStore.thinkingLevel && sessionStore.sessionId) {
			connection.send({
				type: 'set_thinking_level',
				sessionId: sessionStore.sessionId,
				level: selectedLevel,
			});
		}
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
				title="Thinking level: {sessionStore.thinkingLevel}"
			>
				<BrainCog class="size-3" />
				<span class="text-xs">{labelFor(sessionStore.thinkingLevel)}</span>
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
