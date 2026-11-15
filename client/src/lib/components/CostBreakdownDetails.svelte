<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { PimoteUsageBreakdown } from '@pimote/shared';
  import { formatCostUsd, summarizeCostDisclosure } from '$lib/cost-disclosure.js';
  import { formatTokenCount } from '$lib/session-summary.js';
  import { formatCacheHitRate } from '$lib/usage-summary.js';

  interface Props {
    totalCostUsd: number | null | undefined;
    breakdown?: PimoteUsageBreakdown;
    tokenBreakdown?: PimoteUsageBreakdown['tokens'];
    collapsible?: boolean;
  }

  type CostRow = Readonly<{ label: string; tokens: number; cost: number | null }>;

  let { totalCostUsd, breakdown, tokenBreakdown, collapsible = false }: Props = $props();
  let expanded = $state(false);
  let disclosure = $derived(summarizeCostDisclosure(totalCostUsd, breakdown));
  let tokens = $derived(breakdown?.tokens ?? tokenBreakdown);
  let rows = $derived.by((): CostRow[] => {
    if (!tokens) return [];
    const costs = breakdown?.cost;
    return [
      { label: 'Input', tokens: tokens.input, cost: costs?.input ?? null },
      { label: 'Output', tokens: tokens.output, cost: costs?.output ?? null },
      { label: 'Cache read', tokens: tokens.cacheRead, cost: costs?.cacheRead ?? null },
      { label: 'Cache write', tokens: tokens.cacheWrite, cost: costs?.cacheWrite ?? null },
    ];
  });
  let totalTokens = $derived(breakdown?.tokens.total ?? tokenBreakdown?.total);
  let showDetails = $derived(!collapsible || expanded);

  function formatTokens(value: number): string {
    return Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('en-US')} tok` : '—';
  }

  function formatCategoryCost(value: number): string {
    return formatCostUsd(value) ?? '—';
  }

  function totalCostLabel(): string {
    if (disclosure) return disclosure.label;
    if (totalCostUsd === null || totalCostUsd === undefined) return '—';
    return formatCostUsd(totalCostUsd) ?? '—';
  }
</script>

{#if rows.length > 0}
  <div class="cost-breakdown-details min-w-0 text-xs" role="group" aria-label="Cost and token breakdown">
    {#if !collapsible}
      <div class="text-muted-foreground mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 text-[0.65rem] font-medium tracking-wide uppercase">
        <span>Category</span>
        <span class="text-right">Tokens</span>
        <span class="text-right">Cost</span>
      </div>
    {/if}

    {#if collapsible}
      <button
        type="button"
        class="cost-breakdown-toggle text-muted-foreground hover:bg-sidebar-accent/60 focus-visible:ring-ring/50 grid w-full min-w-0 items-center gap-x-2 rounded-sm px-1 py-1 text-left outline-none focus-visible:ring-2 {expanded
          ? 'grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-3 text-[0.65rem] font-medium tracking-wide uppercase'
          : 'grid-cols-[minmax(0,1fr)_auto]'}"
        aria-label={expanded ? 'Collapse usage breakdown' : 'Expand usage breakdown'}
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        {#if expanded}
          <span>Category</span>
          <span class="text-right">Tokens</span>
          <span class="text-right">Cost</span>
        {:else}
          <span class="cost-breakdown-preview flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs tabular-nums" aria-label="Usage preview">
            {#if tokens}
              {@const cacheRate = formatCacheHitRate(tokens)}
              <span>↑{formatTokenCount(tokens.input)}</span>
              <span>↓{formatTokenCount(tokens.output)}</span>
              {#if cacheRate}<span>cache: {cacheRate}</span>{/if}
            {/if}
            <span class="text-foreground font-medium">{totalCostLabel()}</span>
          </span>
        {/if}
        <span class="cost-breakdown-chevron {expanded ? 'expanded' : ''}"><ChevronRight class="size-3.5" /></span>
      </button>
    {/if}

    {#if showDetails}
      <dl class="divide-border/60 divide-y">
        {#each rows as row (row.label)}
          <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1.5">
            <dt>{row.label}</dt>
            <dd class="text-muted-foreground text-right tabular-nums">{formatTokens(row.tokens)}</dd>
            <dd class="text-right tabular-nums">{row.cost === null ? '—' : formatCategoryCost(row.cost)}</dd>
          </div>
        {/each}
        {#if breakdown && disclosure && disclosure.unknownCostUsd !== null}
          <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1.5">
            <dt>Unknown</dt>
            <dd class="text-muted-foreground text-right tabular-nums">—</dd>
            <dd class="text-right tabular-nums">{formatCategoryCost(disclosure.unknownCostUsd)}</dd>
          </div>
        {/if}
        <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 pt-2 font-semibold">
          <dt>Total</dt>
          <dd class="text-muted-foreground text-right tabular-nums">{totalTokens === undefined ? '—' : formatTokens(totalTokens)}</dd>
          <dd class="text-right tabular-nums">{totalCostLabel()}</dd>
        </div>
      </dl>
      {#if !breakdown}<p class="text-muted-foreground mt-2 text-[0.7rem]">Category costs unavailable.</p>{/if}
    {/if}
  </div>
{:else}
  <p class="cost-breakdown-details-empty text-muted-foreground text-xs">Detailed usage breakdown unavailable.</p>
{/if}

<style>
  .cost-breakdown-chevron {
    display: flex;
    align-items: center;
    transition: transform 0.15s;
  }
  .cost-breakdown-chevron.expanded {
    transform: rotate(90deg);
  }
</style>
