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

  // Report focus state to SW so it can suppress notifications when app is focused.
  // Workaround for desktop Chrome where WindowClient.focused is unreliable in push handlers.
  function sendFocusState() {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'focus_state',
      hasFocus: document.hasFocus(),
    });
  }

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

      window.addEventListener('focus', sendFocusState);
      window.addEventListener('blur', sendFocusState);
      document.addEventListener('visibilitychange', sendFocusState);
      // Send initial state once SW is ready
      navigator.serviceWorker.ready.then(() => sendFocusState());

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
              connection
                .send({
                  type: 'open_session',
                  folderPath: fp,
                  sessionId: sid,
                  force: true,
                })
                .catch(() => {});
            }
          }
        }
      });
    }

    return () => {
      connection.disconnect();
      window.removeEventListener('focus', sendFocusState);
      window.removeEventListener('blur', sendFocusState);
      document.removeEventListener('visibilitychange', sendFocusState);
    };
  });

  function closeSidebar() {
    sidebarOpen = false;
  }
</script>

<div class="bg-background flex h-dvh overflow-hidden">
  <!-- Mobile overlay -->
  {#if sidebarOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30 bg-black/50 md:hidden" onclick={closeSidebar} onkeydown={(e) => e.key === 'Escape' && closeSidebar()}></div>
  {/if}

  <!-- Sidebar -->
  <aside
    class="border-sidebar-border bg-sidebar fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r transition-transform duration-200
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
			md:relative md:z-0 md:translate-x-0"
  >
    <!-- Sidebar header -->
    <div class="border-sidebar-border flex h-12 shrink-0 items-center justify-between border-b px-4">
      <div class="flex items-center gap-2">
        <img src="/pwa/icon-192.png" alt="" class="size-5" />
        <span class="text-sidebar-foreground text-sm font-semibold">Pimote</span>
      </div>
      <div class="flex items-center gap-2">
        <!-- Connection status indicator -->
        <span
          class="size-2 rounded-full {connection.phase === 'ready' ? 'bg-status-connected' : connection.phase === 'idle' ? 'bg-status-error' : 'bg-status-reconnecting'}"
          title={connection.phase === 'ready' ? 'Connected' : connection.phase === 'idle' ? 'Disconnected' : 'Reconnecting'}
        ></span>
        <!-- Close button (mobile only) -->
        <button class="text-muted-foreground hover:text-sidebar-foreground rounded-md p-1 md:hidden" onclick={closeSidebar}>
          <X class="size-4" />
        </button>
      </div>
    </div>

    <!-- Sidebar content -->
    <ScrollArea class="min-h-0 flex-1">
      <FolderList onSessionSelect={closeSidebar} />
    </ScrollArea>
  </aside>

  <!-- Main content -->
  <div class="flex flex-1 flex-col overflow-hidden">
    <!-- Mobile header -->
    <header class="border-border flex h-12 shrink-0 items-center border-b px-4 md:hidden">
      <button class="text-muted-foreground hover:text-foreground rounded-md p-1" onclick={() => (sidebarOpen = true)}>
        <Menu class="size-5" />
      </button>
      <img src="/pwa/icon-192.png" alt="" class="ml-3 size-5" />
      <span class="text-foreground ml-1.5 text-sm font-semibold">Pimote</span>
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
