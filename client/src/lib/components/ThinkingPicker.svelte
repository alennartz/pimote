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

  let conversation = $derived(sessionRegistry.viewedConversation);
  let levels = $derived(conversation?.availableThinkingLevels ?? []);
  let selectedLevel = $derived(conversation?.thinkingLevel ?? 'off');

  function chooseLevel(level: string): void {
    if (conversation) void sessionRegistry.sendSurfaceCommand(conversation.sessionId, { type: 'set_thinking_level', level });
  }

  function labelFor(level: string): string {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }
</script>

<DropdownMenu>
  <DropdownMenuTrigger>
    <Button variant="ghost" size="xs" class="text-muted-foreground gap-1 max-md:min-h-11 max-md:px-3" title="Thinking level: {selectedLevel}">
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
