<script lang="ts">
	import { onMount } from 'svelte';
	import { indexStore } from '$lib/stores/index-store.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';
	import SessionItem from './SessionItem.svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import Plus from '@lucide/svelte/icons/plus';
	import Loader2 from '@lucide/svelte/icons/loader-2';

	let expandedFolders = $state(new Set<string>());
	let expandedSessionLists = $state(new Set<string>());

	const MAX_SESSIONS_SHOWN = 6;

	onMount(() => {
		// Load folders when connected
		if (connection.status === 'connected') {
			indexStore.loadFolders();
		}

		// Also reload when connection status changes to connected
		const unsub = connection.onEvent((event) => {
			if (
				event.type === 'session_opened' ||
				event.type === 'session_closed' ||
				event.type === 'agent_start' ||
				event.type === 'agent_end'
			) {
				indexStore.loadFolders();
			}
		});

		return unsub;
	});

	// Reload folders when connection becomes active
	$effect(() => {
		if (connection.status === 'connected') {
			indexStore.loadFolders();
		}
	});

	function toggleFolder(path: string) {
		const next = new Set(expandedFolders);
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
			// Load sessions for newly expanded folder
			indexStore.loadSessions(path);
		}
		expandedFolders = next;
	}

	function toggleSessionList(path: string) {
		const next = new Set(expandedSessionLists);
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
		}
		expandedSessionLists = next;
	}

	async function newSession(folderPath: string) {
		try {
			await connection.send({
				type: 'open_session',
				folderPath,
			});
		} catch (e) {
			console.error('Failed to create new session:', e);
		}
	}
</script>

<div class="flex flex-col gap-1 p-2">
	{#if indexStore.loading}
		<div class="flex items-center justify-center py-8 text-muted-foreground">
			<Loader2 class="size-5 animate-spin" />
			<span class="ml-2 text-sm">Loading folders…</span>
		</div>
	{:else if indexStore.folders.length === 0}
		<div class="px-3 py-8 text-center text-sm text-muted-foreground">
			{#if connection.status !== 'connected'}
				Connecting to server…
			{:else}
				No folders configured
			{/if}
		</div>
	{:else}
		{#each indexStore.folders as folder (folder.path)}
			{@const expanded = expandedFolders.has(folder.path)}
			{@const sessions = indexStore.sessions.get(folder.path) ?? []}

			<div class="rounded-lg">
				<!-- Folder header -->
				<button
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent active:scale-[0.97] active:bg-sidebar-accent/80"
					onclick={() => toggleFolder(folder.path)}
				>
					<ChevronRight
						class="size-4 shrink-0 text-muted-foreground transition-transform {expanded ? 'rotate-90' : ''}"
					/>
					<FolderIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium text-sidebar-foreground">
							{folder.name}
						</div>
					</div>
					{#if folder.activeSessionCount > 0}
						<span class="size-2 shrink-0 rounded-full bg-status-connected"></span>
					{/if}
				</button>

				<!-- Expanded content: sessions -->
				{#if expanded}
					<div class="ml-4 flex flex-col gap-0.5 border-l border-sidebar-border pl-2 pt-1">
						<!-- New session button at top -->
						<button
							class="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground active:scale-[0.97] active:bg-sidebar-accent/80"
							onclick={() => newSession(folder.path)}
						>
							<Plus class="size-3.5" />
							New session
						</button>

						{#if sessions.length === 0}
							<div class="px-3 py-2 text-xs text-muted-foreground">No sessions</div>
						{:else}
							{@const showAll = expandedSessionLists.has(folder.path)}
							{@const visibleSessions = showAll ? sessions : sessions.slice(0, MAX_SESSIONS_SHOWN)}
							{@const hiddenCount = Math.max(0, sessions.length - MAX_SESSIONS_SHOWN)}

							{#each visibleSessions as session (session.id)}
								<SessionItem {session} folderPath={folder.path} />
							{/each}

							{#if hiddenCount > 0 && !showAll}
								<button
									class="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
									onclick={() => toggleSessionList(folder.path)}
								>
									Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
								</button>
							{:else if showAll && hiddenCount > 0}
								<button
									class="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
									onclick={() => toggleSessionList(folder.path)}
								>
									Show fewer sessions
								</button>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
