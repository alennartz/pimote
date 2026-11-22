<script lang="ts">
  import { Command as CommandPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let { ref = $bindable(null), class: className, ...restProps }: CommandPrimitive.EmptyProps = $props();
</script>

<CommandPrimitive.Empty bind:ref data-slot="command-empty" class={cn('text-muted-foreground py-6 text-center text-sm', className)} {...restProps} />
