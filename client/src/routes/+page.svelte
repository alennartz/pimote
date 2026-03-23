<script lang="ts">
	import FolderList from '$lib/components/FolderList.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import InputBar from '$lib/components/InputBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { sessionStore } from '$lib/stores/session.svelte.js';
</script>

{#if sessionStore.sessionId}
	<!-- Active session view -->
	<div class="flex h-full flex-col">
		<StatusBar />
		<MessageList />
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
	</div>
{/if}
