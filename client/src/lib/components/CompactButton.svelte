<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import Shrink from '@lucide/svelte/icons/shrink';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	async function handleCompact() {
		if (!sessionRegistry.viewed?.sessionId || sessionRegistry.viewed?.isCompacting) return;
		await connection.send({
			type: 'compact',
			sessionId: sessionRegistry.viewed.sessionId,
		});
	}
</script>

<Button
	variant="ghost"
	size="xs"
	disabled={sessionRegistry.viewed?.isCompacting || !sessionRegistry.viewed?.sessionId}
	onclick={handleCompact}
	class="gap-1 text-muted-foreground"
	title={sessionRegistry.viewed?.isCompacting ? 'Compacting…' : 'Compact conversation'}
>
	{#if sessionRegistry.viewed?.isCompacting}
		<Loader2 class="size-3 animate-spin" />
		<span class="text-xs">Compacting…</span>
	{:else}
		<Shrink class="size-3" />
		<span class="text-xs">Compact</span>
	{/if}
</Button>
