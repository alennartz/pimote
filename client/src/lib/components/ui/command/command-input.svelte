<script lang="ts">
  import { Command as CommandPrimitive } from 'bits-ui';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { cn } from '$lib/utils.js';

  let { ref = $bindable(null), class: className, value = $bindable(''), ...restProps }: CommandPrimitive.InputProps = $props();
</script>

<div class="border-border flex items-center gap-2 border-b px-3" data-slot="command-input-wrapper">
  <SearchIcon class="text-muted-foreground size-4 shrink-0" />
  <CommandPrimitive.Input
    bind:ref
    bind:value
    data-slot="command-input"
    class={cn(
      'placeholder:text-muted-foreground flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...restProps}
  />
</div>
