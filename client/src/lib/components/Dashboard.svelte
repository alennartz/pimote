<script lang="ts">
  import { untrack } from 'svelte';
  import ProjectList from '$lib/components/ProjectList.svelte';
  import ManagerChat from '$lib/components/ManagerChat.svelte';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import Bot from '@lucide/svelte/icons/bot';
  import X from '@lucide/svelte/icons/x';

  let managerOpen = $state(false);

  // Seed the project list per connection: reconnects drop the guard so the
  // dashboard refetches against the fresh connection.
  let loadedProjectsForCurrentConnection = false;

  $effect(() => {
    const status = connection.status;

    if (status === 'connected') {
      if (!loadedProjectsForCurrentConnection) {
        loadedProjectsForCurrentConnection = true;
        untrack(() => {
          void projectStore.loadProjects();
        });
      }
      return;
    }

    loadedProjectsForCurrentConnection = false;
  });
</script>

<div class="flex min-h-0 flex-1 overflow-hidden">
  <!-- Projects column: fullscreen on mobile, fixed column beside the manager chat on desktop -->
  <div class="bg-sidebar border-sidebar-border min-h-0 w-full flex-none overflow-y-auto md:w-80 md:border-r">
    <ProjectList />
  </div>

  <!-- Manager chat: side-by-side on desktop -->
  <div class="hidden min-h-0 min-w-0 flex-1 md:block">
    <ManagerChat />
  </div>

  <!-- Manager affordance (mobile only): opens the fullscreen chat sheet -->
  <button
    class="bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium shadow-lg md:hidden"
    onclick={() => (managerOpen = true)}
  >
    <Bot class="size-4" />
    Manager
  </button>

  {#if managerOpen}
    <!-- Mobile manager sheet -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30 bg-black/50 md:hidden" onclick={() => (managerOpen = false)} onkeydown={(e) => e.key === 'Escape' && (managerOpen = false)}></div>
    <div class="bg-background fixed inset-0 z-40 flex flex-col md:hidden">
      <div class="border-border flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div class="flex items-center gap-2">
          <Bot class="text-muted-foreground size-4" />
          <span class="text-foreground text-sm font-semibold">Manager</span>
        </div>
        <button class="text-muted-foreground hover:text-foreground rounded-md p-1" onclick={() => (managerOpen = false)} title="Close manager">
          <X class="size-5" />
        </button>
      </div>
      <div class="min-h-0 flex-1">
        <ManagerChat />
      </div>
    </div>
  {/if}
</div>
