<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import Shrink from '@lucide/svelte/icons/shrink';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	async function handleCompact() {
		if (!sessionStore.sessionId || sessionStore.isCompacting) return;
		await connection.send({
			type: 'compact',
			sessionId: sessionStore.sessionId,
		});
	}
</script>

<Button
	variant="ghost"
	size="xs"
	disabled={sessionStore.isCompacting || !sessionStore.sessionId}
	onclick={handleCompact}
	class="gap-1 text-muted-foreground"
	title={sessionStore.isCompacting ? 'Compacting…' : 'Compact conversation'}
>
	{#if sessionStore.isCompacting}
		<Loader2 class="size-3 animate-spin" />
		<span class="text-xs">Compacting…</span>
	{:else}
		<Shrink class="size-3" />
		<span class="text-xs">Compact</span>
	{/if}
</Button>
