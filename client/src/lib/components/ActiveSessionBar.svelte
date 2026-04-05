<script lang="ts">
  import { X, Plus } from '@lucide/svelte';
  import { sessionRegistry, switchToSession, closeSession, newSessionInProject } from '$lib/stores/session-registry.svelte.js';
  import { getExtensionUiQueue } from '$lib/stores/extension-ui-queue.svelte.js';

  const uiQueue = getExtensionUiQueue();
</script>

{#if sessionRegistry.activeSessions.length > 0}
  <div class="border-border bg-muted/30 flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-t px-2 py-1.5">
    {#each sessionRegistry.activeSessions as session (session.sessionId)}
      {@const isViewed = sessionRegistry.viewedSessionId === session.sessionId}
      {@const hasPendingUi = uiQueue.hasRequestForSession(session.sessionId)}
      {#if isViewed}
        <!-- Active chip: split pill with red close zone on mobile, hover X on desktop -->
        <div class="group/chip flex shrink-0 items-stretch overflow-hidden rounded-full">
          <button
            class="bg-primary text-primary-foreground flex items-center gap-1.5 py-1 pr-3 pl-3 text-xs font-medium transition-colors md:rounded-r-full md:pr-3"
            onclick={() => switchToSession(session.sessionId)}
            onauxclick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeSession(session.sessionId);
              }
            }}
            title={session.projectName}
          >
            <!-- Status dot -->
            <span class="relative flex size-2">
              {#if hasPendingUi}
                <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
              {:else if session.status === 'working'}
                <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
              {:else if session.needsAttention}
                <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
              {:else}
                <span class="relative inline-flex size-2 rounded-full bg-gray-400"></span>
              {/if}
            </span>
            <span class="max-w-[80px] truncate">{session.projectName}</span>
            <!-- Desktop hover X (hidden on mobile) -->
            <span
              class="hover:bg-primary-foreground/20 text-primary-foreground/50 hover:text-primary-foreground -mr-1 ml-0.5 hidden items-center justify-center rounded-full p-0.5 transition-colors md:flex md:opacity-0 md:group-hover/chip:opacity-100"
              role="button"
              tabindex="-1"
              title="Close session"
              onclick={(e) => {
                e.stopPropagation();
                closeSession(session.sessionId);
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  closeSession(session.sessionId);
                }
              }}
            >
              <X class="size-3" />
            </span>
          </button>
          <!-- Mobile red close zone (hidden on desktop) -->
          <button
            class="flex items-center justify-center bg-red-600/80 py-1 pr-2.5 pl-1.5 transition-colors hover:bg-red-500/80 active:bg-red-400/80 md:hidden"
            title="Close session"
            onclick={() => closeSession(session.sessionId)}
          >
            <X class="text-primary-foreground size-3" />
          </button>
        </div>
      {:else}
        <!-- Inactive chip -->
        <button
          class="group/chip bg-secondary text-secondary-foreground hover:bg-secondary/80 flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
          onclick={() => switchToSession(session.sessionId)}
          onauxclick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeSession(session.sessionId);
            }
          }}
          title={session.projectName}
        >
          <!-- Status dot -->
          <span class="relative flex size-2">
            {#if hasPendingUi}
              <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
            {:else if session.status === 'working'}
              <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
            {:else if session.needsAttention}
              <span class="relative inline-flex size-2 rounded-full bg-orange-500"></span>
            {:else}
              <span class="relative inline-flex size-2 rounded-full bg-gray-400"></span>
            {/if}
          </span>
          <span class="max-w-[80px] truncate">{session.projectName}</span>
          <span
            class="hover:bg-secondary-foreground/20 text-secondary-foreground/50 hover:text-secondary-foreground -mr-1 ml-0.5 hidden items-center justify-center rounded-full p-0.5 transition-colors md:flex md:opacity-0 md:group-hover/chip:opacity-100"
            role="button"
            tabindex="-1"
            title="Close session"
            onclick={(e) => {
              e.stopPropagation();
              closeSession(session.sessionId);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                closeSession(session.sessionId);
              }
            }}
          >
            <X class="size-3" />
          </span>
        </button>
      {/if}
    {/each}

    <!-- New session ghost chip -->
    {#if sessionRegistry.viewedSessionId}
      <button
        class="border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors"
        title="New session in {sessionRegistry.viewed?.projectName}"
        onclick={() => newSessionInProject(sessionRegistry.viewedSessionId!)}
      >
        <Plus class="size-3" />
        <span>New</span>
      </button>
    {/if}
  </div>
{/if}
