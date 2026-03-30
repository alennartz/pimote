<script lang="ts">
	import './layout.css';

	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import FolderList from '$lib/components/FolderList.svelte';
	import ExtensionDialog from '$lib/components/ExtensionDialog.svelte';
	import ExtensionStatus from '$lib/components/ExtensionStatus.svelte';
	import InstallBanner from '$lib/components/InstallBanner.svelte';
	import Menu from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import { connection } from '$lib/stores/connection.svelte.js';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { onMount } from 'svelte';

	let { children } = $props();
	let sidebarOpen = $state(false);

	onMount(() => {
		connection.connect();

		// Handle ?sessionId=xxx&folderPath=xxx from notification click (app was closed)
		const urlParams = new URLSearchParams(window.location.search);
		const notificationSessionId = urlParams.get('sessionId');
		const notificationFolderPath = urlParams.get('folderPath');
		if (notificationSessionId && notificationFolderPath) {
			window.history.replaceState({}, '', window.location.pathname);
			connection.pendingAdopt = { sessionId: notificationSessionId, folderPath: notificationFolderPath };
		}

		// Register service worker for push notifications and PWA
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker
				.register('/sw.js')
				.then((reg) => console.log('[pimote] Service worker registered:', reg))
				.catch((err) => console.warn('[pimote] Service worker registration failed:', err));

			// Handle messages from service worker
			navigator.serviceWorker.addEventListener('message', async (event) => {
				if (event.data?.type === 'push_notification') {
					const sid = event.data.sessionId;
					if (sid) {
						const session = sessionRegistry.sessions[sid];
						if (session) {
							session.needsAttention = true;
						}
					}
				} else if (event.data?.type === 'notification_click') {
					const sid = event.data.sessionId;
					const fp = event.data.folderPath;
					if (sid) {
						const { switchToSession, sessionRegistry: reg } = await import('$lib/stores/session-registry.svelte.js');
						if (reg.sessions[sid]) {
							// Already open — just switch to it
							switchToSession(sid);
						} else if (fp) {
							// Not open — adopt via open_session
							connection.send({
								type: 'open_session',
								folderPath: fp,
								sessionId: sid,
								force: true,
							}).catch(() => {});
						}
					}
				}
			});
		}

		return () => connection.disconnect();
	});

	function closeSidebar() {
		sidebarOpen = false;
	}
</script>

<div class="flex h-dvh overflow-hidden bg-background">
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
			<FolderList onSessionSelect={closeSidebar} />
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
		<main class="flex flex-1 flex-col overflow-hidden">
			{@render children()}
		</main>

		<!-- Extension status bar & widgets -->
		<ExtensionStatus />
	</div>

	<!-- Extension UI dialogs (global overlay) -->
	<ExtensionDialog />

	<!-- PWA install prompt (mobile only) -->
	<InstallBanner />
</div>
