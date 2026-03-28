<script lang="ts">
	import { sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
</script>

{#if sessionRegistry.activeSessions.length > 0}
	<div class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-muted/30 px-2 py-1.5">
		{#each sessionRegistry.activeSessions as session (session.sessionId)}
			{@const isViewed = sessionRegistry.viewedSessionId === session.sessionId}
			<button
				class="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors
					{isViewed ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
				onclick={() => switchToSession(session.sessionId)}
				title={session.projectName}
			>
				<!-- Status dot -->
				<span class="relative flex size-2">
					{#if session.status === 'working'}
						<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
						<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
					{:else if session.needsAttention}
						<span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
					{:else}
						<span class="relative inline-flex size-2 rounded-full bg-gray-400"></span>
					{/if}
				</span>
				<span class="max-w-[80px] truncate">{session.projectName}</span>
			</button>
		{/each}
	</div>
{/if}
