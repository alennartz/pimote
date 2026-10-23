<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let { ref = $bindable(null), class: className, ...restProps }: PopoverPrimitive.OverlayProps = $props();
</script>

<PopoverPrimitive.Overlay bind:ref data-slot="popover-overlay" class={cn('fixed inset-0 z-50 bg-black/20', className)} {...restProps} />
