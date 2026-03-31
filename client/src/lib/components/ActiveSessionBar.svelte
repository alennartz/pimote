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
      <button
        class="group/chip flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors
					{isViewed ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
        onclick={() => switchToSession(session.sessionId)}
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
        <!-- Close: viewed chip = always-visible "Close" text, others = × on desktop hover -->
        {#if isViewed}
          <span
            class="-mr-0.5 ml-1.5 rounded px-1 py-0.5 text-[11px] leading-none font-medium text-red-300 transition-colors hover:text-red-200"
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
            Close
          </span>
        {:else}
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
        {/if}
      </button>
    {/each}

    <!-- New session ghost chip -->
    {#if sessionRegistry.viewedSessionId}
      <button
        class="border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors"
        title="New session in {sessionRegistry.viewed?.projectName}"
        onclick={() => newSessionInProject(sessionRegistry.viewedSessionId!)}
      >
        <Plus class="size-3" />
        <span>New</span>
      </button>
    {/if}
  </div>
{/if}
