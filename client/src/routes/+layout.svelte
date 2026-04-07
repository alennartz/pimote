<script lang="ts">
  import './layout.css';

  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import FolderList from '$lib/components/FolderList.svelte';
  import ExtensionDialog from '$lib/components/ExtensionDialog.svelte';
  import ExtensionStatus from '$lib/components/ExtensionStatus.svelte';
  import InstallBanner from '$lib/components/InstallBanner.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import SessionSettingsDialog from '$lib/components/SessionSettingsDialog.svelte';
  import { getContextDisplay, getContextTone, getSessionDisplayName } from '$lib/session-summary.js';
  import Menu from '@lucide/svelte/icons/menu';
  import X from '@lucide/svelte/icons/x';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import { pushSharedImages } from '$lib/stores/input-bar.svelte.js';
  import { resolveAppViewportHeight } from '$lib/app-viewport.js';
  import { onMount } from 'svelte';

  let { children } = $props();
  let sidebarOpen = $state(false);
  let panelOpen = $state(false);
  let appHeight = $state('100dvh');

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

    let delayedAppHeightUpdate: ReturnType<typeof setTimeout> | null = null;
    const updateAppHeight = () => {
      appHeight = resolveAppViewportHeight(window);
    };
    const scheduleAppHeightUpdate = () => {
      updateAppHeight();
      requestAnimationFrame(updateAppHeight);
      if (delayedAppHeightUpdate) clearTimeout(delayedAppHeightUpdate);
      delayedAppHeightUpdate = setTimeout(updateAppHeight, 100);
    };

    scheduleAppHeightUpdate();

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scheduleAppHeightUpdate);
    viewport?.addEventListener('scroll', scheduleAppHeightUpdate);
    window.addEventListener('resize', scheduleAppHeightUpdate);
    window.addEventListener('orientationchange', scheduleAppHeightUpdate);
    window.addEventListener('pageshow', scheduleAppHeightUpdate);
    window.addEventListener('focus', scheduleAppHeightUpdate);
    window.addEventListener('focusin', scheduleAppHeightUpdate);
    window.addEventListener('focusout', scheduleAppHeightUpdate);

    // Handle ?sessionId=xxx&folderPath=xxx from notification click (app was closed)
    const urlParams = new URLSearchParams(window.location.search);
    const notificationSessionId = urlParams.get('sessionId');
    const notificationFolderPath = urlParams.get('folderPath');
    if (notificationSessionId && notificationFolderPath) {
      window.history.replaceState({}, '', window.location.pathname);
      connection.pendingAdopt = { sessionId: notificationSessionId, folderPath: notificationFolderPath };
    }

    // Handle ?share=pending from Web Share Target (app was not open)
    if (urlParams.get('share') === 'pending') {
      window.history.replaceState({}, '', window.location.pathname);
      caches.open('pimote-share-target').then(async (cache) => {
        const response = await cache.match('/_share/pending');
        if (response) {
          const images: string[] = await response.json();
          await cache.delete('/_share/pending');
          if (images.length > 0) {
            pushSharedImages(images);
          }
        }
      });
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
        } else if (event.data?.type === 'share_images') {
          const images: string[] = event.data.images;
          if (images?.length > 0) {
            pushSharedImages(images);
          }
        } else if (event.data?.type === 'notification_click') {
          const sid = event.data.sessionId;
          const fp = event.data.folderPath;
          if (sid) {
            const { switchToSession, sessionRegistry: reg, openExistingSession } = await import('$lib/stores/session-registry.svelte.js');
            if (reg.sessions[sid]) {
              // Already open — just switch to it
              switchToSession(sid);
            } else if (fp) {
              // Not open — adopt via unified open path
              void openExistingSession(sid, fp, { force: true, switchTo: true });
            }
          }
        }
      });
    }

    return () => {
      connection.disconnect();
      viewport?.removeEventListener('resize', scheduleAppHeightUpdate);
      viewport?.removeEventListener('scroll', scheduleAppHeightUpdate);
      window.removeEventListener('resize', scheduleAppHeightUpdate);
      window.removeEventListener('orientationchange', scheduleAppHeightUpdate);
      window.removeEventListener('pageshow', scheduleAppHeightUpdate);
      window.removeEventListener('focus', scheduleAppHeightUpdate);
      window.removeEventListener('focusin', scheduleAppHeightUpdate);
      window.removeEventListener('focusout', scheduleAppHeightUpdate);
      if (delayedAppHeightUpdate) clearTimeout(delayedAppHeightUpdate);
      window.removeEventListener('focus', sendFocusState);
      window.removeEventListener('blur', sendFocusState);
      document.removeEventListener('visibilitychange', sendFocusState);
    };
  });

  function closeSidebar() {
    sidebarOpen = false;
  }

  let browserTitle = $derived.by(() => {
    const extensionTitle = sessionRegistry.viewed?.extensionTitle ?? null;
    return extensionTitle ? `Pimote — ${extensionTitle}` : 'Pimote';
  });

  let mobileHeaderTitle = $derived(getSessionDisplayName(sessionRegistry.viewed) ?? 'Pimote');
  let mobileContextDisplay = $derived(getContextDisplay(sessionRegistry.viewed, { compact: true }));
  let mobileContextTone = $derived(getContextTone(sessionRegistry.viewed?.contextUsage?.percent));
  let mobileContextChipClass = $derived(
    mobileContextTone === 'critical'
      ? 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
      : mobileContextTone === 'warning'
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-border bg-muted text-muted-foreground',
  );

  $effect(() => {
    document.title = browserTitle;
  });

  $effect(() => {
    if (!panelStore.hasCards && panelOpen) {
      panelOpen = false;
    }
  });
</script>

<div class="bg-background flex overflow-hidden" style={`height: ${appHeight};`}>
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
    <header class="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
      <button class="text-muted-foreground hover:text-foreground rounded-md p-1" onclick={() => (sidebarOpen = true)} title="Open sidebar">
        <Menu class="size-5" />
      </button>

      <div class="min-w-0 flex-1">
        <div class="text-foreground truncate text-sm font-semibold">{mobileHeaderTitle}</div>
      </div>

      {#if sessionRegistry.viewedSessionId && mobileContextDisplay}
        <span class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium {mobileContextChipClass}" title="Context window usage">
          {mobileContextDisplay}
        </span>
      {/if}

      {#if panelStore.hasCards}
        <button
          class="text-muted-foreground hover:text-foreground border-border bg-background relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border"
          onclick={() => (panelOpen = true)}
          title="Open panel"
        >
          <PanelRight class="size-4" />
          <span class="bg-primary text-primary-foreground absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-medium">
            {panelStore.cards.length}
          </span>
        </button>
      {/if}

      {#if sessionRegistry.viewedSessionId}
        <SessionSettingsDialog />
      {/if}
    </header>

    <!-- Page content -->
    <main class="flex flex-1 flex-col overflow-hidden">
      {@render children()}
    </main>

    <!-- Extension status bar & widgets -->
    <ExtensionStatus />
  </div>

  <!-- Desktop panel (flex sibling of main content) -->
  {#if panelStore.hasCards}
    <div class="hidden md:flex">
      <Panel />
    </div>
  {/if}

  <!-- Mobile panel overlay -->
  {#if panelStore.hasCards && panelOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30 bg-black/50 md:hidden" onclick={() => (panelOpen = false)} onkeydown={(e) => e.key === 'Escape' && (panelOpen = false)}></div>
    <div class="fixed inset-y-0 right-0 z-40 md:hidden">
      <Panel />
    </div>
  {/if}

  <!-- Mobile panel opener now lives in the mobile header to avoid bottom-right control collisions. -->

  <!-- Extension UI dialogs (global overlay) -->
  <ExtensionDialog />

  <!-- PWA install prompt (mobile only) -->
  <InstallBanner />
</div>
