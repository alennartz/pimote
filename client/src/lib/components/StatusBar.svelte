<script lang="ts">
  import ModelPicker from './ModelPicker.svelte';
  import ThinkingPicker from './ThinkingPicker.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { GitBranch } from '@lucide/svelte';

  let connectionLabel = $derived(
    connection.phase === 'ready'
      ? 'Connected'
      : connection.phase === 'syncing'
        ? connection.syncProgress
          ? `Syncing ${connection.syncProgress.done}/${connection.syncProgress.total}…`
          : 'Syncing…'
        : connection.phase === 'connecting'
          ? 'Connecting…'
          : connection.phase === 'backoff'
            ? `Retry in ${connection.reconnectCountdown}s`
            : 'Disconnected',
  );

  let connectionColor = $derived(
    connection.phase === 'ready'
      ? 'bg-emerald-500'
      : connection.phase === 'syncing'
        ? 'bg-blue-500'
        : connection.phase === 'backoff' || connection.phase === 'connecting'
          ? 'bg-amber-500'
          : 'bg-red-500',
  );

  let contextPercent = $derived(sessionRegistry.viewed?.contextUsage?.percent);
  let contextWindow = $derived(sessionRegistry.viewed?.contextUsage?.contextWindow ?? 0);

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return `${n}`;
  }

  let contextDisplay = $derived(
    contextPercent != null ? `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}` : contextWindow > 0 ? `?/${formatTokens(contextWindow)}` : null,
  );

  let contextColor = $derived(
    contextPercent != null && contextPercent > 90 ? 'text-red-400' : contextPercent != null && contextPercent > 70 ? 'text-amber-400' : 'text-muted-foreground',
  );

  let sessionDisplayName = $derived.by(() => {
    const viewed = sessionRegistry.viewed;
    if (!viewed) return null;
    if (viewed.sessionName) return viewed.sessionName;
    if (viewed.firstMessage) {
      return viewed.firstMessage.length > 60 ? viewed.firstMessage.slice(0, 60) + '…' : viewed.firstMessage;
    }
    return null;
  });
</script>

<div class="border-border bg-muted/30 text-muted-foreground shrink-0 border-b text-xs">
  <!-- Row 1: controls + status -->
  <div class="flex h-9 items-center gap-1 px-2">
    <!-- Model picker -->
    <ModelPicker />

    <Separator orientation="vertical" class="mx-0.5 h-4" />

    <!-- Thinking level picker -->
    <ThinkingPicker />

    <!-- Session name (desktop: centered in spacer area) -->
    {#if sessionDisplayName}
      <Separator orientation="vertical" class="mx-0.5 hidden h-4 md:block" />
      <span class="text-muted-foreground hidden max-w-[16rem] truncate text-xs md:inline" title={sessionDisplayName}>
        {sessionDisplayName}
      </span>
    {/if}

    <!-- Spacer -->
    <div class="flex-1"></div>

    <!-- Context usage (desktop only — shown in row 2 on mobile) -->
    {#if contextDisplay}
      <span class="hidden items-center gap-1 md:flex {contextColor}" title="Context window usage">
        {contextDisplay}
      </span>
    {/if}

    <!-- Git branch (desktop only — shown in row 2 on mobile) -->
    {#if sessionRegistry.viewed?.gitBranch}
      <span class="text-muted-foreground hidden items-center gap-1 md:flex" title="Git branch">
        <GitBranch class="size-3" />
        <span class="max-w-[8rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
      </span>

      <Separator orientation="vertical" class="mx-0.5 hidden h-4 md:block" />
    {/if}

    <!-- Streaming indicator -->
    {#if sessionRegistry.viewed?.isStreaming}
      <Badge variant="secondary" class="gap-1.5 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
        </span>
        Streaming
      </Badge>
    {/if}

    <!-- Compacting indicator -->
    {#if sessionRegistry.viewed?.isCompacting}
      <Badge variant="secondary" class="gap-1 text-xs">
        <span class="relative flex size-2">
          <span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
        </span>
        Compacting…
      </Badge>
    {/if}

    <!-- Connection status -->
    <div class="flex items-center gap-1.5" title={connectionLabel}>
      <span class="relative flex size-2">
        {#if connection.phase === 'syncing' || connection.phase === 'connecting'}
          <span class="absolute inline-flex size-full animate-ping rounded-full {connectionColor} opacity-75"></span>
        {/if}
        <span class="relative inline-flex size-2 rounded-full {connectionColor}"></span>
      </span>
      <span class="hidden text-xs sm:inline">{connectionLabel}</span>
    </div>
  </div>

  <!-- Row 2: session name + git branch + context usage (mobile only) -->
  {#if sessionDisplayName || sessionRegistry.viewed?.gitBranch || contextDisplay}
    <div class="border-border/50 flex h-7 items-center gap-2 border-t px-2 md:hidden">
      {#if sessionDisplayName}
        <span class="text-muted-foreground min-w-0 flex-1 truncate" title={sessionDisplayName}>
          {sessionDisplayName}
        </span>
      {/if}

      {#if sessionRegistry.viewed?.gitBranch}
        <span class="text-muted-foreground flex shrink-0 items-center gap-1" title="Git branch">
          <GitBranch class="size-3" />
          <span class="max-w-[6rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
        </span>
      {/if}

      {#if contextDisplay}
        <span class="flex shrink-0 items-center gap-1 {contextColor}" title="Context window usage">
          {contextDisplay}
        </span>
      {/if}
    </div>
  {/if}
</div>
