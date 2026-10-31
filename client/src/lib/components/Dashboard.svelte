<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import GlobalSettingsDialog from './GlobalSettingsDialog.svelte';
  import { globalSettingsStore } from '$lib/stores/global-settings.svelte.js';
  import { serverCapabilities } from '$lib/stores/server-capabilities.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Settings from '@lucide/svelte/icons/settings';

  let viewport = $state<'desktop' | 'mobile'>('desktop');
  onMount(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const updateViewport = () => {
      viewport = query.matches ? 'mobile' : 'desktop';
    };
    updateViewport();
    query.addEventListener('change', updateViewport);
    return () => query.removeEventListener('change', updateViewport);
  });
  import HomeToolbar from '$lib/components/HomeToolbar.svelte';
  import FolderList from '$lib/components/FolderList.svelte';
  import { isPlaceholderSessionId, submitManagerMessage, type ManagerSubmitPorts } from '$lib/manager-composer.js';
  import { closeOpenSwipeCard } from '$lib/components/SwipeableCard.svelte';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { openNewSession, sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';

  let search = $state('');
  let scrollElement = $state<HTMLDivElement | null>(null);
  let managerMode = $state(false);
  let managerDraft = $state('');
  let managerBusy = $state(false);
  let managerReady = $derived(connection.ready && connection.managerRoot !== null);

  const managerPorts: ManagerSubmitPorts = {
    openManagerSession: async (managerRoot) => {
      const response = await openNewSession(managerRoot);
      const sessionId = (response.data as { sessionId?: string } | undefined)?.sessionId;
      return { success: response.success, ...(sessionId !== undefined ? { sessionId } : {}) };
    },
    prompt: async (sessionId, message) => {
      try {
        return (await connection.send({ type: 'prompt', sessionId, message })).success;
      } catch (e) {
        console.error('Failed to prompt manager session:', e);
        return false;
      }
    },
    switchToSession,
  };

  async function submitManagerDraft(text: string): Promise<void> {
    const managerRoot = connection.managerRoot;
    if (!managerRoot || !managerReady) return;
    managerBusy = true;
    try {
      const viewed = sessionRegistry.viewed;
      const sent = await submitManagerMessage(
        {
          viewed: viewed ? { sessionId: viewed.sessionId } : undefined,
          viewedIsManager: viewed != null && !isPlaceholderSessionId(viewed.sessionId) && viewed.folderPath === managerRoot,
          managerRoot,
          text,
        },
        managerPorts,
      );
      if (sent) managerDraft = '';
    } finally {
      managerBusy = false;
    }
  }

  $effect(() => {
    if (connection.status === 'connected') {
      untrack(() => {
        void folderStore.ensureLoaded();
      });
    }
  });
</script>

<GlobalSettingsDialog store={globalSettingsStore} {viewport} snippets={serverCapabilities.tagSnippets} />

<div class="flex min-h-0 flex-1">
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" bind:this={scrollElement} onscroll={closeOpenSwipeCard}>
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-10 px-5 pt-12 pb-28 md:max-w-4xl md:pt-16">
      <div class="grid w-full grid-cols-[auto_1fr_auto] items-start gap-2.5">
        <Button variant="ghost" size="icon" class="size-9 shrink-0" aria-label="Open Settings" title="Open Settings" onclick={() => void globalSettingsStore.loadManifest()}>
          <Settings class="size-5" />
        </Button>
        <div class="flex items-center justify-center gap-2.5">
          <img src="/pwa/icon-512.png" alt="" class="border-border size-[90px] rounded-xl border object-cover" />
          <span class="text-foreground text-4xl font-semibold tracking-tight">Pimote</span>
        </div>
        <div class="size-9" aria-hidden="true"></div>
      </div>

      <HomeToolbar bind:search bind:managerMode bind:managerDraft {managerReady} busy={managerBusy} onSubmitManager={submitManagerDraft} />

      <section>
        <FolderList {search} {scrollElement} />
      </section>
    </div>
  </div>
</div>
