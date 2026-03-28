<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import FolderList from '$lib/components/FolderList.svelte';
	import ExtensionDialog from '$lib/components/ExtensionDialog.svelte';
	import ExtensionStatus from '$lib/components/ExtensionStatus.svelte';
	import Menu from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import { connection } from '$lib/stores/connection.svelte.js';
	import { onMount } from 'svelte';

	let { children } = $props();
	let sidebarOpen = $state(false);

	onMount(() => {
		connection.connect();

		// Register service worker for push notifications
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch((err) => {
				console.warn('[pimote] Service worker registration failed:', err);
			});
		}

		// Handle in-app push messages from service worker
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.addEventListener('message', (event) => {
				if (event.data?.type === 'push_notification') {
					// Could trigger a toast notification or update session bar
					console.log('[pimote] Push notification received:', event.data);
				}
			});
		}

		return () => connection.disconnect();
	});

	function closeSidebar() {
		sidebarOpen = false;
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex h-screen overflow-hidden bg-background">
	<!-- Mobile overlay -->
	{#if sidebarOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed inset-0 z-30 bg-black/50 md:hidden"
			onclick={closeSidebar}
			onkeydown={(e) => e.key === 'Escape' && closeSidebar()}
		></div>
	{/if}

	<!-- Sidebar -->
	<aside
		class="fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
			md:relative md:z-0 md:translate-x-0"
	>
		<!-- Sidebar header -->
		<div class="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
			<span class="text-sm font-semibold text-sidebar-foreground">Pimote</span>
			<div class="flex items-center gap-2">
				<!-- Connection status indicator -->
				<span
					class="size-2 rounded-full {connection.status === 'connected'
						? 'bg-status-connected'
						: connection.status === 'reconnecting'
							? 'bg-status-reconnecting'
							: 'bg-status-error'}"
					title={connection.status}
				></span>
				<!-- Close button (mobile only) -->
				<button
					class="rounded-md p-1 text-muted-foreground hover:text-sidebar-foreground md:hidden"
					onclick={closeSidebar}
				>
					<X class="size-4" />
				</button>
			</div>
		</div>

		<!-- Sidebar content -->
		<ScrollArea class="flex-1">
			<FolderList />
		</ScrollArea>
	</aside>

	<!-- Main content -->
	<div class="flex flex-1 flex-col overflow-hidden">
		<!-- Mobile header -->
		<header class="flex h-12 shrink-0 items-center border-b border-border px-4 md:hidden">
			<button
				class="rounded-md p-1 text-muted-foreground hover:text-foreground"
				onclick={() => (sidebarOpen = true)}
			>
				<Menu class="size-5" />
			</button>
			<span class="ml-3 text-sm font-semibold text-foreground">Pimote</span>
		</header>

		<!-- Page content -->
		<main class="flex-1 overflow-auto">
			{@render children()}
		</main>

		<!-- Extension status bar & widgets -->
		<ExtensionStatus />
	</div>

	<!-- Extension UI dialogs (global overlay) -->
	<ExtensionDialog />
</div>
