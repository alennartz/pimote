<script lang="ts">
	import FolderList from '$lib/components/FolderList.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import InputBar from '$lib/components/InputBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ActiveSessionBar from '$lib/components/ActiveSessionBar.svelte';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';

	function killConflicts() {
		const sessionId = sessionRegistry.viewedSessionId;
		const pids = sessionRegistry.viewed?.conflictingProcesses?.map((p) => p.pid) ?? [];
		if (!sessionId) return;
		connection.send({
			type: 'kill_conflicting_processes',
			sessionId,
			pids,
		}).catch(() => {});
		sessionRegistry.clearConflict(sessionId);
	}

	function dismissConflicts() {
		const sessionId = sessionRegistry.viewedSessionId;
		if (!sessionId) return;
		sessionRegistry.clearConflict(sessionId);
	}
</script>

{#if sessionRegistry.viewedSessionId}
	<!-- Active session view -->
	<div class="flex h-full flex-col">
		<StatusBar />
		{#if sessionRegistry.viewed?.conflictingProcesses?.length}
			<div class="flex items-center gap-2 bg-destructive/10 border-b border-destructive/30 px-4 py-2 text-sm text-destructive">
				<span>External pi processes detected in this project.</span>
				<button class="ml-auto rounded bg-destructive px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-destructive/80" onclick={killConflicts}>
					Kill & Continue
				</button>
				<button class="rounded border border-destructive/30 px-3 py-1 text-xs font-medium hover:bg-destructive/20" onclick={dismissConflicts}>
					Dismiss
				</button>
			</div>
		{/if}
		<MessageList />
		<ActiveSessionBar />
		<InputBar />
	</div>
{:else}
	<!-- Landing / folder browser -->
	<div class="flex h-full flex-col items-center justify-center p-8">
		<h1 class="mb-2 text-2xl font-bold text-foreground">Pimote</h1>
		<p class="mb-8 text-sm text-muted-foreground">Select a folder and session from the sidebar to get started.</p>

		<!-- Show folder browser inline on mobile as well -->
		<div class="w-full max-w-md md:hidden">
			<FolderList />
		</div>

		<ActiveSessionBar />
	</div>
{/if}
