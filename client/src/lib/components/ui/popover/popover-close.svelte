<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';

  let { ref = $bindable(null), type = 'button', ...restProps }: PopoverPrimitive.CloseProps = $props();
</script>

<PopoverPrimitive.Close bind:ref data-slot="popover-close" {type} {...restProps} />
