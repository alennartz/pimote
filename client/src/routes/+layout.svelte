<script lang="ts">
  import './layout.css';

  // Side-effect import: registers the registry's URL-sync navigator at app boot.
  // Lives in the layout (not the dashboard page) so deep links to /sessions/<id>
  // and reloads on a session route register it too — otherwise every
  // registry-driven navigation silently no-ops.
  import '$lib/nav.js';

  import ExtensionDialog from '$lib/components/ExtensionDialog.svelte';
  import ConfigFileEditor from '$lib/components/ConfigFileEditor.svelte';
  import ExtensionStatus from '$lib/components/ExtensionStatus.svelte';
  import InstallBanner from '$lib/components/InstallBanner.svelte';
  import NotificationBanner from '$lib/components/NotificationBanner.svelte';
  import UpdateBanner from '$lib/components/UpdateBanner.svelte';
  // Side-effect import: subscribes the voice-call store to server events at app boot.
  import '$lib/stores/voice-call-store.js';
  // Side-effect import: subscribes the login store to `login_step` events at app boot.
  import '$lib/stores/login-store.js';
  import BranchExplorer from '$lib/components/BranchExplorer.svelte';
  import LoginDialog from '$lib/components/LoginDialog.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import DownloadToast from '$lib/components/DownloadToast.svelte';
  import DownloadInbox from '$lib/components/DownloadInbox.svelte';
  import SessionDetailsDialog from '$lib/components/SessionDetailsDialog.svelte';
  import SessionRenameDialog from '$lib/components/SessionRenameDialog.svelte';
  import { getContextDisplay, getContextTone, getSessionDisplayName } from '$lib/session-summary.js';
  import { getAppName } from '$lib/branding.js';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Settings from '@lucide/svelte/icons/settings';
  import X from '@lucide/svelte/icons/x';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { globalSettingsStore } from '$lib/stores/global-settings.svelte.js';
  import { syncThemeConnection } from '$lib/stores/theme-store-runtime.svelte.js';
  import { routeNotificationIntent, sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import { pushSubscription } from '$lib/stores/push-subscription.svelte.js';
  import { updateStore } from '$lib/stores/update.svelte.js';
  import { pushSharedImages } from '$lib/stores/input-bar.svelte.js';
  import { resolveAppViewportHeight } from '$lib/app-viewport.js';
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';

  let { children } = $props();
  let appShellEl: HTMLDivElement | undefined = $state();
  let appHeight = $state('100dvh');
  let activeSubagentRoot = $derived(sessionRegistry.viewedSessionId ? sessionRegistry.subagentRoots[sessionRegistry.viewedSessionId] : null);
  let pendingSubagentResurrection = $derived(sessionRegistry.viewedSessionId ? sessionRegistry.getPendingSubagentResurrection(sessionRegistry.viewedSessionId) : null);
  let hasHierarchy = $derived((activeSubagentRoot?.nodes.length ?? 0) > 0);
  let hasPanels = $derived(panelStore.hasCards || hasHierarchy || pendingSubagentResurrection !== null);

  // The registry drives the URL (lib/nav.ts); this closes the loop the other
  // way for the home route. Only the session route adopts its param, so
  // back/forward to '/' would otherwise leave viewedSessionId set — keeping
  // session-scoped chrome (the extension status bar, mobile header) visible
  // on the dashboard. Fires after each navigation completes and the new page
  // is rendered, so the set-then-navigate sequence in switchTo() never races
  // a clear. (`navigation.url` is absent on the initial 'enter' event — read
  // the rendered page's URL instead.)
  afterNavigate(() => {
    if (page.url.pathname === '/') sessionRegistry.adoptHomeRoute();
  });

  // Report focus state to SW so it can suppress notifications when app is focused.
  // Workaround for desktop Chrome where WindowClient.focused is unreliable in push handlers.
  function sendFocusState() {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'focus_state',
      hasFocus: document.hasFocus(),
      // A focused window may still be reconnecting. The service worker uses
      // these session-level facts before suppressing a download push.
      connectionReady: connection.ready,
      subscribedSessionIds: [...connection.subscribedSessions.keys()],
    });
  }

  // Keep the service worker's readiness/subscription view current while a
  // focused tab reconnects or restores sessions, even without a focus event.
  $effect(() => {
    connection.ready;
    [...connection.subscribedSessions.keys()];
    syncThemeConnection();
    if (typeof navigator !== 'undefined') sendFocusState();
  });

  // Register this device's push subscription with the server on every connect.
  // Also creates the subscription when permission is granted but none exists.
  $effect(() => {
    if (connection.status === 'connected') void pushSubscription.refresh();
  });

  onMount(() => {
    const stopPushSubscription = pushSubscription.start();

    // A window opened from a notification must wait until persisted sessions
    // finish restoring before it adopts the notification's owner. The URL is
    // the intent's home: don't strip the params here — adoption navigates to
    // /sessions/<id> and drops them naturally, and a reload before adoption
    // completes re-reads them instead of losing the click.
    const urlParams = new URLSearchParams(window.location.search);
    const notificationSessionId = urlParams.get('sessionId');
    const notificationFolderPath = urlParams.get('folderPath');
    const openDownloads = urlParams.get('openDownloads') === 'true';
    if (notificationSessionId) {
      const folderPath = notificationFolderPath ?? connection.subscribedSessions.get(notificationSessionId);
      if (folderPath) {
        connection.pendingAdopt = {
          sessionId: notificationSessionId,
          folderPath,
          ...(openDownloads ? { openDownloads: true } : {}),
        };
      } else {
        // Nothing can resolve this intent — drop the dead query string.
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    connection.connect();

    let delayedAppHeightUpdate: ReturnType<typeof setTimeout> | null = null;
    const updateAppHeight = () => {
      appHeight = resolveAppViewportHeight(window);
    };
    const scheduleAppHeightUpdate = () => {
      requestAnimationFrame(updateAppHeight);
      if (delayedAppHeightUpdate) clearTimeout(delayedAppHeightUpdate);
      delayedAppHeightUpdate = setTimeout(updateAppHeight, 100);
    };

    scheduleAppHeightUpdate();

    const resizePanelHost = () => {
      const width = appShellEl?.getBoundingClientRect().width;
      if (width !== undefined) panelStore.setContainerWidth(width);
    };
    resizePanelHost();
    const panelResizeObserver = typeof ResizeObserver !== 'undefined' && appShellEl ? new ResizeObserver(resizePanelHost) : null;
    if (panelResizeObserver && appShellEl) panelResizeObserver.observe(appShellEl);

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scheduleAppHeightUpdate);
    viewport?.addEventListener('scroll', scheduleAppHeightUpdate);
    window.addEventListener('resize', scheduleAppHeightUpdate);
    window.addEventListener('orientationchange', scheduleAppHeightUpdate);
    window.addEventListener('pageshow', scheduleAppHeightUpdate);
    window.addEventListener('focus', scheduleAppHeightUpdate);
    window.addEventListener('focusin', scheduleAppHeightUpdate);
    window.addEventListener('focusout', scheduleAppHeightUpdate);

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
      navigator.serviceWorker.addEventListener('message', (event) => {
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
          const sessionId = event.data.sessionId;
          const folderPath = event.data.folderPath;
          if (typeof sessionId === 'string' && sessionId) {
            void routeNotificationIntent({
              sessionId,
              ...(typeof folderPath === 'string' && folderPath ? { folderPath } : {}),
              ...(event.data.openDownloads === true ? { openDownloads: true } : {}),
            });
          }
        }
      });
    }

    return () => {
      stopPushSubscription();
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
      panelResizeObserver?.disconnect();
      window.removeEventListener('focus', sendFocusState);
      window.removeEventListener('blur', sendFocusState);
      document.removeEventListener('visibilitychange', sendFocusState);
    };
  });

  const appName = getAppName();

  let browserTitle = $derived.by(() => {
    const extensionTitle = sessionRegistry.viewed?.extensionTitle ?? null;
    return extensionTitle ? `${appName} — ${extensionTitle}` : appName;
  });

  let mobileChild = $derived(sessionRegistry.viewedSubagentAttachment);
  let mobileChildNode = $derived.by(() => {
    const rootId = sessionRegistry.viewedSessionId;
    const path = rootId ? sessionRegistry.getSelectedSubagentPath?.(rootId) : null;
    return rootId && path ? sessionRegistry.getSubagentNode?.(rootId, path) : null;
  });
  let mobileContextPercent = $derived(mobileChild?.contextUsage?.percent ?? mobileChildNode?.contextFill ?? sessionRegistry.viewed?.contextUsage?.percent);
  let mobileHeaderTitle = $derived(mobileChildNode ? mobileChildNode.path.join('/') : (getSessionDisplayName(sessionRegistry.viewed) ?? appName));
  let mobileHeaderSubtitle = $derived(mobileChild ? getSessionDisplayName(sessionRegistry.viewed) : null);
  let mobileContextDisplay = $derived(
    mobileChild
      ? mobileContextPercent === null || mobileContextPercent === undefined
        ? null
        : `${Math.round(mobileContextPercent)}%`
      : getContextDisplay(sessionRegistry.viewed, { compact: true }),
  );
  let mobileContextTone = $derived(getContextTone(mobileContextPercent));

  function openPanels(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('input, textarea, [contenteditable="true"]')) focused.blur();
    panelStore.openPanel();
  }

  async function closeSelectedChildView(): Promise<void> {
    const rootId = sessionRegistry.viewedSessionId;
    const path = rootId ? sessionRegistry.getSelectedSubagentPath?.(rootId) : null;
    if (!rootId || !path) return;
    await sessionRegistry.closeSubagentView(rootId, path);
    sessionRegistry.selectSubagentView(rootId, null);
  }

  let mobileContextChipClass = $derived(
    mobileContextTone === 'critical'
      ? 'border-status-error/20 bg-status-error/10 text-status-error'
      : mobileContextTone === 'warning'
        ? 'border-warning/20 bg-warning/10 text-status-reconnecting'
        : 'border-border bg-muted text-muted-foreground',
  );

  $effect(() => {
    document.title = browserTitle;
  });
</script>

<div bind:this={appShellEl} class="bg-background flex overflow-hidden" style={`height: ${appHeight};`}>
  <!-- Main content -->
  <div class="flex flex-1 flex-col overflow-hidden">
    <NotificationBanner />
    <UpdateBanner />

    <!-- Mobile header -->
    <header class="border-border flex min-h-12 shrink-0 items-center gap-2 border-b px-3 pt-[max(env(safe-area-inset-top),0.25rem)] md:hidden">
      {#if page.url.pathname === '/'}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors max-md:size-11"
          title="Open Settings"
          aria-label="Open Settings"
          onclick={() => void globalSettingsStore.loadManifest()}
        >
          <Settings class="size-5" />
        </button>
      {/if}
      {#if mobileChild}
        <button
          class="text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors max-md:size-11"
          title="Close child view"
          aria-label="Close child view"
          onclick={() => void closeSelectedChildView()}
        >
          <X class="size-5" />
        </button>
      {:else if sessionRegistry.viewedSessionId}
        <button
          class="text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors max-md:size-11"
          title="Back to dashboard"
          aria-label="Back to dashboard"
          onclick={() => sessionRegistry.goHome()}
        >
          <ArrowLeft class="size-5" />
        </button>
      {/if}
      <div class="min-w-0 flex-1 leading-tight">
        {#if sessionRegistry.viewedSessionId && sessionRegistry.viewed && !mobileChild}
          <SessionRenameDialog
            sessionId={sessionRegistry.viewed.sessionId}
            folderPath={sessionRegistry.viewed.folderPath}
            sessionName={sessionRegistry.viewed.sessionName}
            displayName={mobileHeaderTitle}
          >
            {#snippet children({ openRenameDialog })}
              <button
                type="button"
                class="text-foreground hover:text-foreground block w-full truncate text-left text-sm font-semibold select-none"
                title={`Rename session: ${mobileHeaderTitle}`}
                onclick={openRenameDialog}
              >
                {mobileHeaderTitle}
              </button>
            {/snippet}
          </SessionRenameDialog>
        {:else}
          <div class="text-foreground truncate text-sm font-semibold">{mobileHeaderTitle}</div>
        {/if}
        {#if mobileHeaderSubtitle}
          <div class="text-muted-foreground mt-0.5 truncate text-[11px]">Child view · {mobileHeaderSubtitle}</div>
        {/if}
      </div>

      {#if sessionRegistry.viewedSessionId && mobileContextDisplay}
        <span class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium {mobileContextChipClass}" title="Context window usage">
          {mobileContextDisplay}
        </span>
      {/if}

      {#if sessionRegistry.viewed?.downloads.length}
        <DownloadInbox variant="mobile" />
      {/if}

      {#if hasPanels && panelStore.isDrawer}
        <button
          class="text-muted-foreground hover:text-foreground border-border bg-background relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border max-md:size-11"
          onclick={openPanels}
          title="Open panels"
          aria-label="Open panels"
        >
          <PanelRight class="size-4" />
          <span class="bg-primary text-primary-foreground absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-medium">
            {hasHierarchy ? (activeSubagentRoot?.nodes.length ?? 0) : panelStore.cards.length}
          </span>
        </button>
      {/if}

      {#if sessionRegistry.viewedSessionId}
        <div class="relative">
          <SessionDetailsDialog />
          {#if updateStore.showMarker}
            <span class="bg-primary pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full" aria-hidden="true"></span>
          {/if}
        </div>
      {/if}
    </header>

    <!-- Page content -->
    <main class="flex flex-1 flex-col overflow-hidden">
      {@render children()}
    </main>

    <!-- Extension status bar & widgets -->
    <ExtensionStatus />
  </div>

  <!-- Hierarchy-first panel host. A child hierarchy keeps the host present even
       when no SDK cards exist. The width is measured on the app container in the
       layout observer, not from the viewport media query. -->
  {#if hasPanels && panelStore.presentation === 'sidebar' && panelStore.open && !panelStore.collapsed}
    <div class="flex min-h-0 shrink-0 flex-col">
      <Panel />
    </div>
  {/if}

  <!-- Narrow containers use a dismissible drawer. Opening a child closes it. -->
  {#if hasPanels && panelStore.presentation === 'drawer' && panelStore.open}
    <div
      class="fixed inset-0 z-30 bg-black/50"
      role="presentation"
      onclick={() => panelStore.closePanel()}
      onkeydown={(event) => event.key === 'Escape' && panelStore.closePanel()}
    ></div>
    <div class="fixed inset-y-0 right-0 z-40 flex min-h-0 w-full max-w-[24rem] flex-col" data-panel-drawer>
      <Panel onClose={() => panelStore.closePanel()} />
    </div>
  {/if}

  <!-- Download offer prompt (global overlay) -->
  <DownloadToast />

  <!-- File editor shared by dashboard and session actions -->
  <ConfigFileEditor />

  <!-- Extension UI dialogs (global overlay) -->
  <ExtensionDialog />

  <!-- Branch explorer -->
  <BranchExplorer />

  <!-- Provider login dialog -->
  <LoginDialog />

  <!-- PWA install prompt (mobile only) -->
  <InstallBanner />
</div>
