<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';

  let { ref = $bindable(null), type = 'button', ...restProps }: PopoverPrimitive.TriggerProps = $props();
</script>

<PopoverPrimitive.Trigger bind:ref data-slot="popover-trigger" {type} {...restProps} />
