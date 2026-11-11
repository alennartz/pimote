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

  let child = $derived(sessionRegistry.viewedSubagentAttachment);
  let rootSessionId = $derived(sessionRegistry.viewedSessionId);
  let levels = $derived(child?.state.availableThinkingLevels ?? sessionRegistry.viewed?.availableThinkingLevels ?? []);
  let selectedLevel = $derived(child?.state.thinkingLevel ?? sessionRegistry.viewed?.thinkingLevel ?? 'off');

  function activePath(): import('@pimote/shared').AgentPath | null {
    return rootSessionId ? (sessionRegistry.getSelectedSubagentPath?.(rootSessionId) ?? null) : null;
  }

  function chooseLevel(level: string): void {
    const rootId = rootSessionId;
    const path = activePath();
    if (!rootId || (child && !path)) return;
    void sessionRegistry.sendSurfaceCommand(rootId, child ? path : null, { type: 'set_thinking_level', level }).then((res) => {
      if (!res.success) return;
      if (child) child.state = { ...child.state, thinkingLevel: level };
      else if (sessionRegistry.sessions[rootId]) sessionRegistry.sessions[rootId].thinkingLevel = level;
    });
  }

  function labelFor(level: string): string {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }
</script>

<DropdownMenu>
  <DropdownMenuTrigger>
    <Button variant="ghost" size="xs" class="text-muted-foreground gap-1" title="Thinking level: {selectedLevel}">
      <BrainCog class="size-3" />
      <span class="text-xs">{labelFor(selectedLevel)}</span>
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class="min-w-36">
    <DropdownMenuLabel>Thinking Level</DropdownMenuLabel>
    <DropdownMenuSeparator />
    <DropdownMenuRadioGroup bind:value={selectedLevel} onValueChange={(value) => chooseLevel(value)}>
      {#each levels as level (level)}
        <DropdownMenuRadioItem value={level}>
          {labelFor(level)}
        </DropdownMenuRadioItem>
      {/each}
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
</DropdownMenu>
