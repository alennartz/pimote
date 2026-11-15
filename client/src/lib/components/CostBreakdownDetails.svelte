<script lang="ts">
  import type { PimoteUsageBreakdown } from '@pimote/shared';
  import { formatCostUsd, summarizeCostDisclosure } from '$lib/cost-disclosure.js';

  interface Props {
    totalCostUsd: number | null | undefined;
    breakdown?: PimoteUsageBreakdown;
    tokenBreakdown?: PimoteUsageBreakdown['tokens'];
  }

  type CostRow = Readonly<{ label: string; tokens: number; cost: number | null }>;

  let { totalCostUsd, breakdown, tokenBreakdown }: Props = $props();
  let disclosure = $derived(summarizeCostDisclosure(totalCostUsd, breakdown));
  let rows = $derived.by((): CostRow[] => {
    const tokens = breakdown?.tokens ?? tokenBreakdown;
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
  </div>
{:else}
  <p class="cost-breakdown-details-empty text-muted-foreground text-xs">Detailed usage breakdown unavailable.</p>
{/if}
