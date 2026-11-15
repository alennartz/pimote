<script lang="ts">
  import { onMount } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import type { PimoteUsageBreakdown } from '@pimote/shared';
  import { summarizeCostDisclosure } from '$lib/cost-disclosure.js';
  import CostBreakdownDetails from './CostBreakdownDetails.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';

  interface Props {
    /** The authoritative Pi session or assistant-row total in USD. */
    totalCostUsd: number | null | undefined;
    /** Optional category and token totals. Older servers can omit this value. */
    breakdown?: PimoteUsageBreakdown;
    /** Token totals for surfaces that lack category cost data. */
    tokenBreakdown?: PimoteUsageBreakdown['tokens'];
    /** Accessible context for this disclosure, such as "Assistant response". */
    contextLabel: string;
  }

  let { totalCostUsd, breakdown, tokenBreakdown, contextLabel }: Props = $props();
  let open = $state(false);
  const instanceId = `cost-breakdown-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const contentId = `${instanceId}-content`;
  const titleId = `${instanceId}-title`;
  const openEventName = 'pimote:cost-breakdown-open';

  let disclosure = $derived(summarizeCostDisclosure(totalCostUsd, breakdown));

  function handleOpenChange(nextOpen: boolean): void {
    open = nextOpen;
    if (nextOpen && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(openEventName, { detail: instanceId }));
    }
  }

  function closeWhenAnotherOpens(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail !== instanceId) open = false;
  }

  onMount(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(openEventName, closeWhenAnotherOpens);
    return () => window.removeEventListener(openEventName, closeWhenAnotherOpens);
  });
</script>

{#if disclosure}
  <Popover.Root {open} onOpenChange={handleOpenChange}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="cost-disclosure-trigger text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 cursor-pointer rounded-sm px-0.5 text-xs tabular-nums no-underline outline-none focus-visible:ring-2"
          aria-label={`${contextLabel}: ${disclosure.label}. Show cost breakdown`}
          aria-expanded={open}
          aria-controls={contentId}
        >
          {disclosure.label}
        </button>
      {/snippet}
    </Popover.Trigger>

    <Popover.Content
      id={contentId}
      role="dialog"
      aria-labelledby={titleId}
      aria-label={`${contextLabel} cost breakdown`}
      align="start"
      class="cost-disclosure-popover w-72 max-w-[calc(100vw-1rem)] p-3"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id={titleId} class="text-sm font-semibold">{contextLabel} cost</h2>
        </div>
        <Popover.Close>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mt-1 -mr-1 inline-flex size-7 items-center justify-center rounded-md outline-none focus-visible:ring-2"
              aria-label="Close cost breakdown"
            >
              <X class="size-4" />
              <span class="sr-only">Close cost breakdown</span>
            </button>
          {/snippet}
        </Popover.Close>
      </div>

      <CostBreakdownDetails {totalCostUsd} {breakdown} {tokenBreakdown} />
    </Popover.Content>
  </Popover.Root>
{/if}
