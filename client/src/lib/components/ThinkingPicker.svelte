<script lang="ts">
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
    DropdownMenuLabel,
    DropdownMenuSeparator,
  } from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import BrainCog from '@lucide/svelte/icons/brain-cog';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  // Full canonical set of thinking levels known to pi-ai (in display order).
  // Used as a fallback when the server hasn't provided availableThinkingLevels
  // yet (e.g. older server, or before first state sync).
  const FALLBACK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

  // Prefer the server-provided per-model list (correct across model capabilities,
  // including new levels like 'xhigh' on Opus 4.7 / GPT-5.2+). Fall back to the
  // canonical set if the server didn't supply one.
  let levels = $derived(sessionRegistry.viewed?.availableThinkingLevels?.length ? sessionRegistry.viewed.availableThinkingLevels : (FALLBACK_LEVELS as readonly string[]));

  let selectedLevel = $derived(sessionRegistry.viewed?.thinkingLevel ?? 'off');

  // Send command when local selection changes from store value
  $effect(() => {
    const viewedLevel = sessionRegistry.viewed?.thinkingLevel ?? 'off';
    if (selectedLevel !== viewedLevel && sessionRegistry.viewed?.sessionId) {
      const sid = sessionRegistry.viewed.sessionId;
      const level = selectedLevel;
      connection
        .send({
          type: 'set_thinking_level',
          sessionId: sid,
          level,
        })
        .then((res) => {
          if (res.success) {
            const session = sessionRegistry.sessions[sid];
            if (session) session.thinkingLevel = level;
          }
        });
    }
  });

  function labelFor(level: string): string {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }
</script>

<DropdownMenu>
  <DropdownMenuTrigger>
    <Button variant="ghost" size="xs" class="text-muted-foreground gap-1" title="Thinking level: {sessionRegistry.viewed?.thinkingLevel ?? 'off'}">
      <BrainCog class="size-3" />
      <span class="text-xs">{labelFor(sessionRegistry.viewed?.thinkingLevel ?? 'off')}</span>
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class="min-w-36">
    <DropdownMenuLabel>Thinking Level</DropdownMenuLabel>
    <DropdownMenuSeparator />
    <DropdownMenuRadioGroup bind:value={selectedLevel}>
      {#each levels as level (level)}
        <DropdownMenuRadioItem value={level}>
          {labelFor(level)}
        </DropdownMenuRadioItem>
      {/each}
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
</DropdownMenu>
