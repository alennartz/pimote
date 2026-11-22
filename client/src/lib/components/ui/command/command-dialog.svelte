<script lang="ts">
  import type { Command as CommandPrimitive, Dialog as DialogPrimitive } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Command from './command.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import type { WithoutChildrenOrChild } from '$lib/utils.js';

  let {
    open = $bindable(false),
    onOpenChange,
    onOpenChangeComplete,
    ref = $bindable(null),
    value = $bindable(''),
    title = 'Command Palette',
    description = 'Search for folders, sessions, or commands',
    portalProps,
    onOpenAutoFocus,
    children,
    ...commandProps
  }: WithoutChildrenOrChild<CommandPrimitive.RootProps> & {
    open?: boolean;
    onOpenChange?: DialogPrimitive.RootProps['onOpenChange'];
    onOpenChangeComplete?: DialogPrimitive.RootProps['onOpenChangeComplete'];
    portalProps?: DialogPrimitive.PortalProps;
    onOpenAutoFocus?: DialogPrimitive.ContentProps['onOpenAutoFocus'];
    children: Snippet;
    title?: string;
    description?: string;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange} {onOpenChangeComplete}>
  <Dialog.Content class="overflow-hidden p-0 sm:max-w-lg" {portalProps} {onOpenAutoFocus} showCloseButton={false}>
    <Dialog.Header class="sr-only">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>
    <Command
      bind:ref
      bind:value
      {...commandProps}
      class="[&_[data-command-group-heading]]:text-muted-foreground [&_[data-command-group-heading]]:px-2 [&_[data-command-group-heading]]:font-medium [&_[data-command-group]:not([hidden])_~[data-command-group]]:pt-0"
    >
      {@render children?.()}
    </Command>
  </Dialog.Content>
</Dialog.Root>
