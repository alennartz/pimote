<script lang="ts">
  import { pushSubscription } from '$lib/stores/push-subscription.svelte.js';
  import Bell from '@lucide/svelte/icons/bell';

  // Visible until this device is subscribed. No dismissal state: the
  // subscription itself is the source of truth. The layout drives refresh.
  let show = $derived(pushSubscription.status !== null && pushSubscription.status !== 'subscribed' && pushSubscription.status !== 'unsupported');
</script>

{#if show}
  <div class="border-border bg-muted/50 flex flex-col border-b">
    <div class="flex items-center gap-3 px-4 py-3">
      <Bell class="text-muted-foreground size-4 shrink-0" />
      {#if pushSubscription.status === 'blocked'}
        <span class="text-foreground flex-1 text-sm">Notifications are blocked. Allow them for this site in browser settings.</span>
      {:else if pushSubscription.status === 'needs-subscription'}
        <span class="text-foreground flex-1 text-sm">Notification setup did not finish.</span>
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/80 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          onclick={() => pushSubscription.refresh()}
        >
          Retry
        </button>
      {:else}
        <span class="text-foreground flex-1 text-sm">Enable notifications to know when sessions finish.</span>
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/80 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          onclick={() => pushSubscription.enable()}
          disabled={pushSubscription.enabling}
        >
          {pushSubscription.enabling ? 'Enabling…' : 'Enable'}
        </button>
      {/if}
    </div>
    {#if pushSubscription.error}
      <div class="text-destructive px-4 pb-3 text-xs">{pushSubscription.error}</div>
    {/if}
  </div>
{/if}
