<script lang="ts">
  import { onMount } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import type { PimoteUsageBreakdown } from '@pimote/shared';
  import { summarizeCostDisclosure } from '$lib/cost-disclosure.js';
  import * as Popover from '$lib/components/ui/popover/index.js';

  interface Props {
    /** The authoritative Pi session or assistant-row total in USD. */
    totalCostUsd: number | null | undefined;
    /** Optional category and token totals. Older servers can omit this value. */
    breakdown?: PimoteUsageBreakdown;
    /** Accessible context for this disclosure, such as "Assistant response". */
    contextLabel: string;
  }

  let { totalCostUsd, breakdown, contextLabel }: Props = $props();
  let open = $state(false);
  const instanceId = `cost-breakdown-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const contentId = `${instanceId}-content`;
  const titleId = `${instanceId}-title`;
  const openEventName = 'pimote:cost-breakdown-open';

  let disclosure = $derived(summarizeCostDisclosure(totalCostUsd, breakdown));

  function formatTokens(value: number): string {
    return Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('en-US')} tok` : '—';
  }

  function formatCategoryCost(value: number): string {
    return Number.isFinite(value) && value >= 0 ? `$${value.toFixed(4)}` : '—';
  }

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
          class="cost-disclosure-trigger text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm px-0.5 text-xs tabular-nums underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2"
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
          <p class="text-muted-foreground mt-0.5 text-xs">Total {disclosure.label}</p>
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

      {#if breakdown}
        {@const rows = [
          { label: 'Input', tokens: breakdown.tokens.input, cost: breakdown.cost.input },
          { label: 'Output', tokens: breakdown.tokens.output, cost: breakdown.cost.output },
          { label: 'Cache read', tokens: breakdown.tokens.cacheRead, cost: breakdown.cost.cacheRead },
          { label: 'Cache write', tokens: breakdown.tokens.cacheWrite, cost: breakdown.cost.cacheWrite },
        ]}
        <div class="mt-3 text-xs">
          <div class="text-muted-foreground mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 text-[0.65rem] font-medium tracking-wide uppercase">
            <span>Category</span>
            <span class="text-right">Tokens</span>
            <span class="text-right">Cost</span>
          </div>
          <dl class="divide-border/60 divide-y">
            {#each rows as row (row.label)}
              <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1.5">
                <dt>{row.label}</dt>
                <dd class="text-muted-foreground text-right tabular-nums">{formatTokens(row.tokens)}</dd>
                <dd class="text-right tabular-nums">{formatCategoryCost(row.cost)}</dd>
              </div>
            {/each}
            {#if disclosure.unknownCostUsd !== null}
              <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1.5">
                <dt>Unknown</dt>
                <dd class="text-muted-foreground text-right tabular-nums">—</dd>
                <dd class="text-right tabular-nums">{formatCategoryCost(disclosure.unknownCostUsd)}</dd>
              </div>
            {/if}
            <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 pt-2 font-semibold">
              <dt>Total</dt>
              <dd class="text-muted-foreground text-right tabular-nums">{formatTokens(breakdown.tokens.total)}</dd>
              <dd class="text-right tabular-nums">{disclosure.label}</dd>
            </div>
          </dl>
        </div>

        {#if disclosure.inconsistent}
          <p class="text-destructive mt-3 text-xs">Reported categories exceed the authoritative total.</p>
        {/if}
      {/if}

      <p class="text-muted-foreground mt-3 text-[0.7rem] leading-relaxed">Pi calculates this total from configured model prices. It is not an invoice amount.</p>
    </Popover.Content>
  </Popover.Root>
{/if}
